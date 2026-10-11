// create-foxkit/e2e: run a Firefox extension in a real Firefox from a test.
//
//   const site = await serve("e2e/site");                     // local pages on 127.0.0.1
//   const fox = await launch({ extension: "extension" });     // Firefox + temporary extension
//   const page = await fox.open(`${site.url}/index.html`);    // a Puppeteer Page
//   const value = await poll(page, () => document.title);     // first truthy result
//   const ext = await fox.openExtensionPage("page.html");     // moz-extension://<uuid>/page.html
//   writeArtifact("artifacts", "e2e", { value });              // artifacts/e2e-<date>.json
//   await fox.close(); await site.close();
//
// Remote mode: FOXKIT_BROWSER=ichabod (or launch({ remote: "ichabod" })) runs
// the same test on a Firefox on Ichabod, Mozilla's cloud browser service
// (src/ichabod.ts). serve() then returns a public URL on the one shared
// tunnel of the process (src/tunnel.ts).
//
// Firefox facts this file depends on (docs/failure-modes.md H3, H4):
// WebDriver BiDi refuses moz-extension: pages unless Firefox starts with
// -remote-allow-system-access, and it sends no navigation events for them, so
// goto() never resolves there. openExtensionPage() polls instead. In remote
// mode, the page opens in a frame on the frame host (src/frame.ts, R7).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, extname, join, resolve, sep } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { framedPage, HOST_PAGE } from "./frame.js";
import { checkRemote, connectIchabod, redact, remoteSessions } from "./ichabod.js";
import { browserMode } from "./mode.js";
import { mount, tunnel } from "./tunnel.js";

export type { Browser, Page };
export type { RemoteSession } from "./ichabod.js";
export { type BrowserMode, browserMode } from "./mode.js";
export { closeTunnels, tunnel, type Tunnel, type TunnelOptions } from "./tunnel.js";

export interface LaunchOptions {
  /** The extension directory. Its manifest.json must set browser_specific_settings.gecko.id. */
  extension: string;
  /** The Firefox binary. Default: the FIREFOX variable, then the usual install paths. */
  firefox?: string;
  /** Run without a window. Default: true. */
  headless?: boolean;
  /** More Firefox preferences. Remote mode refuses this option. */
  prefs?: Record<string, unknown>;
  /** "ichabod" runs on Ichabod; "local" runs a local Firefox. Default: FOXKIT_BROWSER, then "local". */
  remote?: "ichabod" | "local";
  /** Remote mode only: record the session to video. Default: true. */
  record?: boolean;
}

export interface Fox {
  /** The Puppeteer browser, for anything this API does not cover. */
  browser: Browser;
  /** The temporary profile directory. close() deletes it. Empty in remote mode. */
  profile: string;
  /** The gecko ID from the manifest. */
  extensionId: string;
  /** moz-extension://<uuid>/<path> for this extension. */
  extensionUrl(path?: string): string;
  /** Open a URL in a new tab and wait for its load event. */
  open(url: string): Promise<Page>;
  /**
   * Open an extension page in a new tab and wait until it is loaded. In remote
   * mode the page is in a frame that fills the tab, and part of the API goes
   * through a relay: see "Extension pages on Ichabod" in the README.
   */
  openExtensionPage(path: string, timeoutMs?: number): Promise<Page>;
  /** Close Firefox and delete the profile (remote: end the session). A second call does nothing. */
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function defaultFirefoxPaths(): string[] {
  if (process.platform === "darwin") return ["/Applications/Firefox.app/Contents/MacOS/firefox", "/Applications/Firefox Nightly.app/Contents/MacOS/firefox"];
  if (process.platform === "win32") return ["C:\\Program Files\\Mozilla Firefox\\firefox.exe"];
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "firefox"));
}

/** The Firefox binary to use. Throws when there is none. */
export function findFirefox(explicit?: string): string {
  const chosen = explicit ?? process.env.FIREFOX;
  if (chosen) {
    if (existsSync(chosen)) return chosen;
    throw new Error(`Cannot find Firefox at ${chosen}. Set FIREFOX to the Firefox binary, or pass the firefox option.`);
  }
  const candidates = defaultFirefoxPaths();
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  throw new Error(`Cannot find Firefox. Looked in: ${candidates.join(", ") || "PATH"}. Set FIREFOX to the Firefox binary.`);
}

function geckoId(extension: string): string {
  const file = join(extension, "manifest.json");
  if (!existsSync(file)) throw new Error(`Cannot find ${file}.`);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as { browser_specific_settings?: { gecko?: { id?: unknown } } };
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (typeof id !== "string" || !id) throw new Error(`${file} must set browser_specific_settings.gecko.id.`);
  return id;
}

/**
 * Call fn in the page until it returns a truthy value, and return that value.
 * Errors count as "not yet", so a page that reloads does not stop the poll.
 * fn runs in the page: pass values through arg, not through a closure.
 */
export async function poll<T, A = undefined>(
  page: { evaluate(fn: never, ...args: never[]): Promise<unknown> },
  fn: (arg: A) => T,
  arg?: A,
  timeoutMs = 30_000,
): Promise<NonNullable<Awaited<T>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = (await (page.evaluate as (f: (arg: A) => T, a: A) => Promise<unknown>)(fn, arg as A).catch(() => null)) as Awaited<T>;
    if (value) return value as NonNullable<Awaited<T>>;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${fn.toString().slice(0, 80)}`);
    await sleep(200);
  }
}

type OpenPage = (browser: Browser, url: string, timeoutMs: number) => Promise<Page>;

function foxFor(browser: Browser, base: string, profile: string, extensionId: string, close: () => Promise<void>, openPage: OpenPage): Fox {
  return {
    browser,
    profile,
    extensionId,
    extensionUrl: (path = "") => base + path.replace(/^\//, ""),
    async open(url) {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "load" });
      return page;
    },
    openExtensionPage: (path, timeoutMs = 30_000) => openPage(browser, base + path.replace(/^\//, ""), timeoutMs),
    close,
  };
}

/** Local mode: the page in its own tab. goto() never resolves there (H4), so poll. */
const openInTab: OpenPage = async (browser, url, timeoutMs) => {
  const page = await browser.newPage();
  page.goto(url, { timeout: 0 }).catch(() => {});
  await poll(page, (u: string) => location.href === u && document.readyState === "complete", url, timeoutMs);
  return page;
};

/** Remote mode: the page in a frame on the frame host, which BiDi can script (R7). */
const openInFrame =
  (host: string): OpenPage =>
  async (browser, url, timeoutMs) => {
    const page = await browser.newPage();
    await page.goto(`${host}/`, { waitUntil: "load" });
    await page.evaluate((u: string) => {
      const frame = document.createElement("iframe");
      frame.allow = "microphone; camera; clipboard-read; clipboard-write; fullscreen";
      frame.src = u;
      document.body.append(frame);
    }, url);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const loaded = await frame.evaluate((u: string) => location.href === u && document.readyState === "complete", url).catch(() => false);
        if (loaded) return framedPage(page, frame, url);
      }
      if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${url} to load in the frame host. The page must be in the extension directory, and must not be a sandbox page.`);
      await sleep(200);
    }
  };

let frameHosts = 0;

/** The frame host: a local page mounted on the shared tunnel. url rejects when the tunnel fails (F4). */
function startFrameHost(): { url: Promise<string>; close: () => Promise<void> } {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(HOST_PAGE);
  });
  const stop = new AbortController();
  const opened = (async () => {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return mount((server.address() as AddressInfo).port, `frame-${++frameHosts}`, { signal: stop.signal });
  })();
  const url = opened.then((t) => t.url);
  url.catch(() => {});
  return {
    url,
    close: async () => {
      stop.abort();
      await (await opened.catch(() => undefined))?.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}

/** Start Firefox with a fresh profile and the extension installed as a temporary add-on. */
export async function launch(options: LaunchOptions): Promise<Fox> {
  const extension = resolve(options.extension);
  const extensionId = geckoId(extension);
  if (browserMode(options.remote) === "ichabod") {
    checkRemote(options);
    // The frame host mounts while the session connects; the install waits for its URL (F4).
    const host = startFrameHost();
    const remote = await connectIchabod({ ...options, extension, host: host.url }).catch(async (error: unknown) => {
      await host.close();
      throw error;
    });
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= remote.close().finally(host.close));
    return foxFor(remote.browser, remote.base, "", extensionId, close, openInFrame(await host.url));
  }
  const executablePath = findFirefox(options.firefox);
  // A fixed UUID makes the moz-extension: URL known before the add-on loads.
  const uuid = randomUUID();
  const base = `moz-extension://${uuid}/`;
  const profile = mkdtempSync(join(tmpdir(), "foxkit-profile-"));
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await browser?.close().catch(() => {});
      rmSync(profile, { recursive: true, force: true });
    })());

  try {
    browser = await puppeteer.launch({
      browser: "firefox",
      executablePath,
      headless: options.headless ?? true,
      userDataDir: profile,
      args: ["-remote-allow-system-access"],
      defaultViewport: null,
      extraPrefsFirefox: { ...options.prefs, "extensions.webextensions.uuids": JSON.stringify({ [extensionId]: uuid }) },
    });
    await browser.installExtension(extension);
  } catch (error) {
    await close();
    throw error;
  }
  return foxFor(browser, base, profile, extensionId, close, openInTab);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve a directory on http://127.0.0.1:<free port>. Paths outside it get 404.
 * With tunnel (default: true when FOXKIT_BROWSER=ichabod), url is a public
 * URL on the shared tunnel.
 */
export async function serve(dir: string, options: { tunnel?: boolean } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const tunneled = options.tunnel ?? browserMode() === "ichabod";
  const root = resolve(dir);
  const server = createServer((req, res) => {
    let file = "";
    try {
      file = resolve(join(root, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)));
    } catch {
      file = "";
    }
    if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const stopServer = () =>
    new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  if (!tunneled) return { url: `http://127.0.0.1:${port}`, close: stopServer };
  const opened = await tunnel(port).catch(async (error: unknown) => {
    await stopServer();
    throw error;
  });
  return {
    url: opened.url,
    close: async () => {
      await opened.close();
      await stopServer();
    },
  };
}

/**
 * Write data to <dir>/<name>-<YYYY-MM-DD>.json and return the path. After a
 * remote run, an object gets an ichabod list of the sessions (R8). The
 * Ichabod key becomes *** (R4).
 */
export function writeArtifact(dir: string, name: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}-${new Date().toISOString().slice(0, 10)}.json`);
  const plain = typeof data === "object" && data !== null && !Array.isArray(data);
  const record = plain && remoteSessions.length > 0 ? { ...data, ichabod: remoteSessions } : data;
  writeFileSync(path, `${redact(JSON.stringify(record, null, 2))}\n`);
  return path;
}
