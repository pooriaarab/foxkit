// Tests for the shared tunnel that need no network: R1 and T1-T5 in
// docs/failure-modes.md. A fake cloudflared stands in for the real one, and
// the readiness probe (DNS and https) is mocked. scripts/e2e-ichabod.mjs uses
// the real Cloudflare service.
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTunnels, serve, tunnel } from "../src/e2e.js";

const probe = vi.hoisted(() => ({ code: 200, urls: [] as string[] }));
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<object>()),
  resolveNs: async () => ["ns.test"],
  resolve4: async () => ["192.0.2.1"],
  Resolver: class {
    setServers() {}
    async resolve4() {
      return ["192.0.2.1"];
    }
  },
}));
vi.mock("node:https", async (original) => ({
  ...(await original<object>()),
  request: (url: string, _options: object, callback: (res: object) => void) => {
    probe.urls.push(url);
    const req = Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => callback({ statusCode: probe.code, resume() {} })), destroy() {} });
    return req;
  },
}));

const saved = { ...process.env };
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foxkit-tunnel-test-"));
  probe.code = 200;
  probe.urls = [];
  delete process.env.FOXKIT_BROWSER;
  delete process.env.CLOUDFLARED;
});
afterEach(async () => {
  await closeTunnels();
  process.env = { ...saved };
});

/** A fake cloudflared that logs its PID and arguments, then runs body. */
function fake(body: string) {
  const path = join(dir, "cloudflared");
  writeFileSync(path, `#!/bin/sh\necho $$ >> "${join(dir, "pids")}"\necho "$@" > "${join(dir, "args")}"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const OPENS = 'echo "https://fake-gateway.trycloudflare.com" >&2\nexec sleep 60';
const pids = () => readFileSync(join(dir, "pids"), "utf8").split("\n").filter(Boolean).map(Number);
const gatewayPort = () => Number(/127\.0\.0\.1:(\d+)/.exec(readFileSync(join(dir, "args"), "utf8"))?.[1]);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A GET to the gateway; returns status, body and location. */
function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; location?: string }>((done, fail) => {
    request({ host: "127.0.0.1", port: gatewayPort(), path, headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c));
      res.on("end", () => done({ status: res.statusCode ?? 0, body, ...(res.headers.location ? { location: res.headers.location } : {}) }));
    }).on("error", fail).end();
  });
}

/** A local server that answers with the path it got, and redirects /go and /away. */
async function echo(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url === "/go") res.writeHead(302, { location: "/login" }).end();
    else if (req.url === "/away") res.writeHead(302, { location: `http://127.0.0.1:${(server.address() as { port: number }).port}/x` }).end();
    else res.end(`${req.headers.host} ${req.url}`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as { port: number }).port, server };
}

describe("R1 an unknown FOXKIT_BROWSER value never runs locally", () => {
  it.each(["ichbod", "ichabod ", "ICHABOD", "remote"])("refuses %j", async (value) => {
    process.env.FOXKIT_BROWSER = value;
    await expect(serve(dir)).rejects.toThrow(JSON.stringify(value));
    await expect(tunnel(1)).rejects.toThrow(/"ichabod" or "local"/);
  });
});

describe("starting the shared tunnel", () => {
  it("T1 names the install command when cloudflared is missing", async () => {
    process.env.CLOUDFLARED = join(dir, "no-cloudflared");
    await expect(tunnel(8080)).rejects.toThrow("brew install cloudflared");
    await expect(tunnel(8080)).rejects.toThrow("CLOUDFLARED");
  });

  it("T2 tries 3 times when cloudflared exits, and shows its output", async () => {
    const cloudflared = fake('echo "failed to request quick Tunnel: 429" >&2\nexit 1');
    await expect(tunnel(8080, { cloudflared, timeoutMs: 5000 })).rejects.toThrow("failed to request quick Tunnel: 429");
    expect(pids()).toHaveLength(3);
  });

  it("T2 T3 gives up on a URL that only answers 530, and stops every cloudflared", async () => {
    probe.code = 530;
    const cloudflared = fake(OPENS);
    await expect(tunnel(8080, { cloudflared, timeoutMs: 800 })).rejects.toThrow("3 tries");
    expect(pids()).toHaveLength(3);
    expect(pids().filter(alive)).toEqual([]);
  }, 20_000);

  it.each([404, 520, 522, 524])("T2 a %d through Cloudflare is not the gateway's 200, so the tunnel is not ready", async (code) => {
    probe.code = code;
    await expect(tunnel(8080, { cloudflared: fake(OPENS), timeoutMs: 800 })).rejects.toThrow("3 tries");
  }, 20_000);

  it("T2 the probe asks the gateway's ready path, and the gateway answers it 200", async () => {
    await tunnel(8080, { cloudflared: fake(OPENS) });
    expect(probe.urls.length).toBeGreaterThan(0);
    expect(probe.urls.every((u) => u === "https://fake-gateway.trycloudflare.com/_foxkit-ready")).toBe(true);
    expect((await get("/_foxkit-ready")).status).toBe(200);
  });

  it("T3 a signal stops a start that is still running", async () => {
    probe.code = 530;
    const stop = new AbortController();
    const started = tunnel(8080, { cloudflared: fake(OPENS), signal: stop.signal });
    // Abort once cloudflared runs, not after a fixed time: a slow spawn would abort before the PID is written.
    await vi.waitFor(() => expect(pids().filter(alive)).toHaveLength(1), { timeout: 10_000, interval: 10 });
    stop.abort();
    await expect(started).rejects.toThrow("stopped before it opened");
    expect(pids().filter(alive)).toEqual([]);
  }, 20_000);
});

describe("T4 one tunnel per process", () => {
  it("mounts every tunnel() and serve() on one cloudflared, at different paths of one origin", async () => {
    process.env.CLOUDFLARED = fake(OPENS);
    writeFileSync(join(dir, "index.html"), "<title>x</title>");
    const opened = [await tunnel(1001), await tunnel(1002), await serve(dir, { tunnel: true }), await serve(dir, { tunnel: true }), await tunnel(1003)];
    expect(pids()).toHaveLength(1);
    const urls = opened.map((t) => new URL(t.url));
    expect(new Set(urls.map((u) => u.origin))).toEqual(new Set(["https://fake-gateway.trycloudflare.com"]));
    expect(new Set(urls.map((u) => u.pathname)).size).toBe(5);
    // T3: closeTunnels() stops the one cloudflared.
    await closeTunnels();
    expect(pids().filter(alive)).toEqual([]);
  });
});

describe("T5 the gateway routes by mount", () => {
  it("strips the prefix, follows the Referer, fixes redirects, and unmounts", async () => {
    process.env.CLOUDFLARED = fake(OPENS);
    const { port, server } = await echo();
    const t = await tunnel(port);
    const path = new URL(t.url).pathname;
    expect(await get(`${path}/a/b.html?x=1`)).toMatchObject({ status: 200, body: `127.0.0.1:${port} /a/b.html?x=1` });
    expect(await get(`${path}?q`)).toMatchObject({ body: `127.0.0.1:${port} /?q` });
    // An absolute path goes to the mount its Referer names, and gets 404 without one.
    expect(await get("/app.js", { referer: `${t.url}/index.html` })).toMatchObject({ status: 200, body: `127.0.0.1:${port} /app.js` });
    expect((await get("/app.js")).status).toBe(404);
    expect((await get("/app.js", { referer: "https://fake-gateway.trycloudflare.com/_foxkit/99/x" })).status).toBe(404);
    // A redirect to /path or to the local URL gets the public prefix.
    expect((await get(`${path}/go`)).location).toBe(`${path}/login`);
    expect((await get(`${path}/away`)).location).toBe(`${t.url}/x`);
    // T3: close() unmounts at once.
    await t.close();
    expect((await get(`${path}/a`)).status).toBe(404);
    server.close();
  });

  it("T6 sends a navigation routed by its Referer back under the mount, and forwards anything else", async () => {
    process.env.CLOUDFLARED = fake(OPENS);
    const { port, server } = await echo();
    const t = await tunnel(port);
    const path = new URL(t.url).pathname;
    const referer = `${t.url}/flights/`;
    // A link or a form to /flights/results: the page URL must keep the prefix, or its next absolute link has no mount.
    expect(await get("/flights/results?from=YYZ", { referer, "sec-fetch-mode": "navigate" })).toMatchObject({ status: 307, location: `${path}/flights/results?from=YYZ` });
    // A script, a style or a fetch from that page is forwarded at once.
    expect(await get("/app.js", { referer, "sec-fetch-mode": "no-cors" })).toMatchObject({ status: 200, body: `127.0.0.1:${port} /app.js` });
    // A navigation that already has the prefix, or that no mount claims, does not change.
    expect(await get(`${path}/flights/book`, { "sec-fetch-mode": "navigate" })).toMatchObject({ status: 200, body: `127.0.0.1:${port} /flights/book` });
    expect((await get("/flights/book", { "sec-fetch-mode": "navigate" })).status).toBe(404);
    server.close();
  });
});
