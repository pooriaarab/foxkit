// tunnel(port): a public https URL for a server on 127.0.0.1, so a cloud
// browser can reach it. docs/failure-modes.md T1-T7.
//
// A process opens ONE quick tunnel (T4): Cloudflare answers 429 after about
// 15. It points at a local gateway, and tunnel() mounts at /_foxkit/<id>/.
// The gateway strips the prefix before it forwards. A request without the
// prefix goes to the server its Referer names, and a redirect to /path gets
// the prefix back, so pages that use absolute paths keep working (T5). A
// navigation routed by its Referer is sent back under the mount (307), so
// the next page keeps the prefix for its own links (T6). One server may
// mount at the root, for what no mount claims (T7).
// All mounted servers share one origin. WebSocket upgrades are not forwarded.
//
// WARNING: anyone who has the URL reaches the mounted servers until close().
// Protect a model server with its own key (llama-server --api-key).
import { type ChildProcess, spawn } from "node:child_process";
import { Resolver, resolve4, resolveNs } from "node:dns/promises";
import { createServer, type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { request } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { browserMode } from "./mode.js";

export interface TunnelOptions {
  /** The cloudflared binary. Default: the CLOUDFLARED variable, then cloudflared on PATH. */
  cloudflared?: string;
  /** How long one try to start the shared tunnel may take, in ms. Default: 45000. There are 3 tries. */
  timeoutMs?: number;
  /** Stops a start that is still running: cloudflared exits and tunnel() rejects. */
  signal?: AbortSignal;
  /** Mount at the root of the tunnel, not under /_foxkit/<id>, so the server sees its own paths (T7). One at a time. */
  root?: boolean;
}

export interface Tunnel {
  /** https://<random>.trycloudflare.com/_foxkit/<id> */
  url: string;
  /** Unmount the server: the URL answers 404 at once. A second call does nothing. */
  close(): Promise<void>;
}

export const PREFIX = "/_foxkit/";
/** The gateway answers 200 here, so a 200 through Cloudflare proves the tunnel reaches it (T2). */
const READY = "/_foxkit-ready";
const TRIES = 3;
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const open = new Set<ChildProcess>();
let hooked = false;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function stop(child: ChildProcess): Promise<void> {
  open.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.ref(); // T3: unref'd, the wait for the exit would not keep the process alive either.
  return new Promise((done) => {
    child.once("exit", () => done());
    child.kill("SIGTERM");
  });
}

function killAll() {
  for (const child of open) child.kill("SIGTERM");
}

// T3: a tunnel must not outlive the test process.
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.once("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      killAll();
      process.kill(process.pid, signal);
    });
  }
}

let authority: Promise<Resolver> | undefined;

// Ask the trycloudflare.com name servers: a caching resolver asked too early keeps NXDOMAIN for minutes (T2).
function authoritative(): Promise<Resolver> {
  return (authority ??= (async () => {
    const names = await resolveNs("trycloudflare.com");
    const addresses = (await Promise.all(names.map((name) => resolve4(name).catch(() => [])))).flat();
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    resolver.setServers(addresses);
    return resolver;
  })().catch((error: unknown) => {
    authority = undefined;
    throw error;
  }));
}

/** The HTTP status for url, with the host resolved by its name servers, or 0. */
async function status(url: string): Promise<number> {
  const resolver = await authoritative().catch(() => undefined);
  const address = (await resolver?.resolve4(new URL(url).hostname).catch(() => []))?.[0];
  if (!address) return 0;
  return new Promise((done) => {
    const req = request(url, {
      timeout: 5000,
      lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
        options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)) as never,
    }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(0));
    req.end();
  });
}

async function attempt(binary: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<{ child: ChildProcess; url: string } | { output: string }> {
  const child = spawn(binary, ["tunnel", "--no-autoupdate", "--grace-period", "1s", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  open.add(child);
  hookExit();
  let output = "";
  // The URL comes early in a long banner, so keep it apart from the output tail.
  const state = { missing: false, url: "" };
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
    state.url ||= URL_PATTERN.exec(output)?.[0] ?? "";
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error: NodeJS.ErrnoException) => {
    state.missing = error.code === "ENOENT";
    output += `\n${error.message}`;
  });
  const deadline = Date.now() + timeoutMs;
  const aborted = () => signal?.aborted === true;
  while (Date.now() < deadline && child.exitCode === null && !state.missing && !aborted()) {
    const url = state.url;
    // Only the gateway answers 200 on READY. Cloudflare answers 530 before the
    // tunnel connects, and 502 or 52x while it cannot reach the gateway.
    const code = url ? await status(`${url}${READY}`) : 0;
    if (code === 200) return { child, url };
    await sleep(500);
  }
  await stop(child);
  if (aborted()) throw new Error("The shared tunnel was stopped before it opened.");
  if (state.missing) throw new Error(`Cannot run ${binary}. Install cloudflared (brew install cloudflared), or set CLOUDFLARED to its path.`);
  return { output };
}

/** Start cloudflared for http://127.0.0.1:<port>. The child does not keep the process alive; exit stops it (T3). */
async function quickTunnel(port: number, options: TunnelOptions): Promise<{ url: string; child: ChildProcess }> {
  const binary = options.cloudflared ?? process.env.CLOUDFLARED ?? "cloudflared";
  let last = "";
  for (let i = 0; i < TRIES; i++) {
    const result = await attempt(binary, port, options.timeoutMs ?? 45_000, options.signal);
    if ("url" in result) {
      result.child.unref();
      for (const stream of [result.child.stdout, result.child.stderr]) (stream as Socket | null)?.unref();
      return result;
    }
    last = result.output;
  }
  throw new Error(`cloudflared did not open a working tunnel to 127.0.0.1:${port} in ${TRIES} tries. Its last output:\n${last.trim().split("\n").slice(-8).join("\n")}`);
}

// The gateway: mount id -> local port.
/** The server mounted at the root of the tunnel (T7), if any. */
let root: { port: number } | undefined;
const routes = new Map<string, number>();
let shared: Promise<{ origin: string; stop: () => Promise<void> }> | undefined;
let nextId = 1;

/** The mount, and the path to forward, for a request (T5). byReferer: no prefix, the Referer named the mount. Undefined: answer 404. */
function route(req: IncomingMessage): { id: string; port: number; path: string; byReferer?: true } | undefined {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  const [pathname, query] = q < 0 ? [url, ""] : [url.slice(0, q), url.slice(q)];
  const mounted = /^\/_foxkit\/([a-z0-9-]+)(\/.*)?$/s.exec(pathname);
  if (mounted) {
    const id = mounted[1] ?? "";
    const port = routes.get(id);
    return port === undefined ? undefined : { id, port, path: (mounted[2] ?? "/") + query };
  }
  // An absolute path from a page under a mount: the Referer names the mount.
  let referer = "";
  try {
    referer = new URL(req.headers.referer ?? "").pathname;
  } catch {
    // No Referer, or not a URL: no mount claims the request.
  }
  const from = /^\/_foxkit\/([a-z0-9-]+)\//.exec(referer)?.[1];
  const port = from === undefined ? undefined : routes.get(from);
  if (from !== undefined && port !== undefined) return { id: from, port, path: url, byReferer: true };
  // T7: what no mount claims goes to the root mount, with its path as it is.
  return root === undefined ? undefined : { id: "", port: root.port, path: url };
}

/** A Location header the browser can follow: /path gets the mount prefix, a local URL becomes public. */
function relocate(location: string, id: string, port: number, origin: string): string {
  const local = `http://127.0.0.1:${port}`;
  if (!id) return location.startsWith(local) ? `${origin}${location.slice(local.length) || "/"}` : location;
  if (location.startsWith(local)) return `${origin}${PREFIX}${id}${location.slice(local.length) || "/"}`;
  if (location.startsWith("/") && !location.startsWith("//") && !location.startsWith(PREFIX)) return `${PREFIX}${id}${location}`;
  return location;
}

function forward(origin: () => string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === READY) {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("ready");
      return;
    }
    const target = route(req);
    if (!target) {
      res.writeHead(404, { "content-type": "text/plain" }).end("No server is mounted at this path.");
      return;
    }
    // T6: a page reached without the prefix would send a Referer with no mount from its own links.
    if (target.byReferer && req.headers["sec-fetch-mode"] === "navigate") {
      res.writeHead(307, { location: `${PREFIX}${target.id}${target.path}`, "cache-control": "no-store" }).end();
      req.resume();
      return;
    }
    const upstream = httpRequest({ host: "127.0.0.1", port: target.port, method: req.method, path: target.path, headers: { ...req.headers, host: `127.0.0.1:${target.port}`, ...(target.id ? { "x-forwarded-prefix": `${PREFIX}${target.id}` } : {}) } }, (answer) => {
      const headers = { ...answer.headers };
      if (typeof headers.location === "string") headers.location = relocate(headers.location, target.id, target.port, origin());
      res.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("The mounted server did not answer.");
    });
    req.pipe(upstream);
  };
}

/** The shared gateway and its one quick tunnel. A failed start is not kept, so the next call tries again. */
function startShared(options: TunnelOptions): Promise<{ origin: string; stop: () => Promise<void> }> {
  return (shared ??= (async () => {
    let origin = "";
    const gateway = createServer(forward(() => origin));
    await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
    gateway.unref();
    const stopGateway = () =>
      new Promise<void>((done) => {
        gateway.ref();
        gateway.close(() => done());
        gateway.closeAllConnections();
      });
    try {
      const opened = await quickTunnel((gateway.address() as AddressInfo).port, options);
      origin = opened.url;
      return { origin, stop: async () => (await stop(opened.child), await stopGateway()) };
    } catch (error) {
      await stopGateway();
      throw error;
    }
  })().catch((error: unknown) => {
    shared = undefined;
    throw error;
  }));
}

/** Mount a local server on the shared tunnel under the given id, or the next number, or at the root (T7). */
export async function mount(port: number, id?: string, options: TunnelOptions = {}): Promise<Tunnel> {
  browserMode();
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`tunnel() needs a TCP port, not ${JSON.stringify(port)}.`);
  if (options.root) {
    if (root) throw new Error("A server is already mounted at the root of the tunnel. Close it first.");
    const { origin } = await startShared(options);
    if (root) throw new Error("A server is already mounted at the root of the tunnel. Close it first.");
    const mine = { port };
    root = mine;
    return {
      url: origin,
      close: async () => {
        if (root === mine) root = undefined;
      },
    };
  }
  const name = id ?? String(nextId++);
  if (routes.has(name)) throw new Error(`A server is already mounted at ${PREFIX}${name}.`);
  const { origin } = await startShared(options);
  routes.set(name, port);
  return {
    url: `${origin}${PREFIX}${name}`,
    close: async () => {
      if (routes.get(name) === port) routes.delete(name);
    },
  };
}

/** A public https URL for http://127.0.0.1:<port>, on the one shared quick tunnel (T4). */
export function tunnel(port: number, options: TunnelOptions = {}): Promise<Tunnel> {
  return mount(port, undefined, options);
}

/** Stop the shared tunnel and the gateway now, not at process exit. The next tunnel() starts a new one. */
export async function closeTunnels(): Promise<void> {
  const running = shared;
  shared = undefined;
  routes.clear();
  root = undefined;
  await (await running?.catch(() => undefined))?.stop();
}
