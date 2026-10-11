// Tests for the frame host that need no network: F1-F3, F6-F9 and R9 in
// docs/failure-modes.md. The shim and the relay run in node:vm with a fake
// browser object. scripts/e2e-ichabod.mjs runs them in a real Firefox.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { framePlan, relayScript, shimScript } from "../src/frame.js";
import { connectIchabod } from "../src/ichabod.js";

const ORIGIN = "https://frame-host.trycloudflare.com";
const HOST = `${ORIGIN}/_foxkit/frame-1`;
const BASE = "moz-extension://0d6c2bb4-0c43-4a0e-8b39-7f5a1d0e9a11/";
const plan = framePlan({ permissions: ["storage", "tabs", "notifications", "webRequest", "proxy"], sidebar_action: {} });

type Listener = (...args: unknown[]) => void;
const clone = (m: unknown) => structuredClone(m);
const listeners = () => {
  const fns = new Set<Listener>();
  return { fns, addListener: (fn: Listener) => fns.add(fn), removeListener: (fn: Listener) => fns.delete(fn), emit: (...a: unknown[]) => fns.forEach((fn) => fn(...a)) };
};

/** A connected pair of fake ports: page side and background side. */
function portPair(name: string, sender: object) {
  const pageIn = listeners();
  const bgIn = listeners();
  const pageGone = listeners();
  const bgGone = listeners();
  // Like Firefox, postMessage clones at once, so a value it cannot clone throws in the caller.
  const post = (to: ReturnType<typeof listeners>) => (m: unknown) => {
    const copy = clone(m);
    queueMicrotask(() => to.emit(copy));
  };
  const page = { name, onMessage: pageIn, onDisconnect: pageGone, postMessage: post(bgIn) };
  const bg = { name, sender, onMessage: bgIn, onDisconnect: bgGone, postMessage: post(pageIn), disconnect: () => queueMicrotask(() => pageGone.emit()) };
  return { page, bg };
}

/** A fake background page with the relay script loaded, and a framed page with the shim. */
function setup({ top = false, ancestor = ORIGIN, sender = {} as Record<string, unknown>, has = [] as string[], session = false, framePlanned = plan } = {}) {
  const onConnect = listeners();
  const onUpdated = listeners();
  const onSessionChanged = listeners();
  const sessionData: Record<string, unknown> = {};
  const calls: unknown[][] = [];
  const bgBrowser = {
    runtime: { id: "a@b", getURL: (p: string) => BASE + p, onConnect },
    tabs: {
      query: async (q: unknown) => (calls.push(["tabs.query", q]), [{ id: 7, url: "https://x.test/" }, { id: 1, windowId: 3, url: `${HOST}/` }]),
      get: async (id: number) => (id === 99 ? { id, windowId: 3, url: "https://x.test/", run: () => 0 } : { id, windowId: 3, url: id === 1 ? `${HOST}/` : "https://x.test/" }),
      getCurrent: async () => undefined,
      onUpdated,
    },
    windows: { get: async (id: number, info: unknown) => (calls.push(["windows.get", id, info]), { id }), getCurrent: async () => ({ id: 99 }) },
    storage: {
      session: {
        get: async (key: string) => (calls.push(["storage.session.get", key]), { [key]: sessionData[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(sessionData, items);
          onSessionChanged.emit(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])));
        },
        onChanged: onSessionChanged,
      },
    },
    permissions: {
      request: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
    },
  };
  runInNewContext(relayScript(framePlanned, HOST), { browser: bgBrowser, URL });
  const fullSender = { id: "a@b", url: `${BASE}app.html`, frameId: 5, tab: { id: 1, windowId: 3, url: `${HOST}/` }, ...sender };
  const pageBrowser: Record<string, unknown> = {
    runtime: { connect: ({ name }: { name: string }) => {
      const { page, bg } = portPair(name, fullSender);
      onConnect.emit(bg);
      return page;
    } },
    storage: session ? { local: {}, session: { real: true } } : { local: {} },
    extension: {},
  };
  for (const ns of has) pageBrowser[ns] = { real: true };
  const window: Record<string, unknown> = {};
  window.top = top ? window : {};
  runInNewContext(shimScript(framePlanned, HOST), { browser: pageBrowser, window, location: { ancestorOrigins: [ancestor] }, console });
  return { browser: pageBrowser as Record<string, any>, calls, onUpdated };
}

describe("F1 the shim adds only what the real page has and the frame lacks", () => {
  it("fills tabs, windows, permissions, sidebarAction and the granted notifications in a frame, and nothing else", () => {
    expect(plan.relayed).toEqual(["notifications", "permissions", "sidebarAction", "storage.session", "tabs", "windows"]);
    const { browser } = setup();
    for (const ns of plan.relayed) expect(typeof ns.split(".").reduce((o, k) => o[k], browser)).toBe("object");
    for (const ns of ["alarms", "cookies", "action", "bookmarks"]) expect(ns in browser).toBe(false);
    expect(browser.tabs.TAB_ID_NONE).toBe(-1);
    expect(browser.tabs.then).toBeUndefined();
  });

  it("changes nothing in a top-level page, in a frame on another origin, or for a namespace the context has", () => {
    expect("tabs" in setup({ top: true }).browser).toBe(false);
    expect("tabs" in setup({ ancestor: "https://evil.test" }).browser).toBe(false);
    expect(setup({ has: ["tabs"] }).browser.tabs).toEqual({ real: true });
  });
});

describe("F2 the relay runs the call in the background page", () => {
  it("returns the real result and passes the arguments", async () => {
    const { browser, calls } = setup();
    expect((await browser.tabs.query({ active: true }))[0]).toEqual({ id: 7, url: "https://x.test/" });
    expect(calls).toEqual([["tabs.query", { active: true }]]);
  });

  it("delivers events to listeners and stops after removeListener", async () => {
    const { browser, onUpdated } = setup();
    const seen: unknown[] = [];
    const fn = (...args: unknown[]) => seen.push(args);
    browser.tabs.onUpdated.addListener(fn);
    expect(browser.tabs.onUpdated.hasListener(fn)).toBe(true);
    await new Promise((done) => setTimeout(done, 10));
    onUpdated.emit(7, { status: "complete" });
    await new Promise((done) => setTimeout(done, 10));
    expect(seen).toEqual([[7, { status: "complete" }]]);
    browser.tabs.onUpdated.removeListener(fn);
    onUpdated.emit(8, {});
    await new Promise((done) => setTimeout(done, 10));
    expect(seen).toHaveLength(1);
  });


});

describe("F3 the relay answers only this extension's pages framed on the host", () => {
  it.each([
    ["a top-level page", { frameId: 0 }],
    ["a frame on another origin", { tab: { id: 1, url: "https://evil.test/" } }],
    ["a frame on another mount of the tunnel", { tab: { id: 1, url: `${ORIGIN}/_foxkit/2/` } }],
    ["a content script", { url: `${HOST}/` }],
    ["another extension", { id: "other@x" }],
  ])("refuses %s", async (_, sender) => {
    await expect(setup({ sender }).browser.tabs.query({})).rejects.toThrow(/relay answers only this extension's pages framed on/);
  });
});

describe("F6 an uncovered call fails loudly", () => {
  it("throws on a granted namespace that is not relayed, and rejects a member that does not exist", async () => {
    const { browser } = setup();
    expect(plan.blocked).toEqual(["proxy", "webRequest"]);
    expect(() => browser.webRequest).toThrow(/browser.webRequest is granted but not relayed/);
    await expect(browser.tabs.nope()).rejects.toThrow("browser.tabs.nope is not a function");
  });

  it("answers getViews() for sidebar and popup only", () => {
    const { browser } = setup();
    expect(browser.extension.getViews({ type: "sidebar" })).toEqual([]);
    expect(() => browser.extension.getViews()).toThrow("getViews");
    expect(() => browser.extension.getViews({ type: "tab" })).toThrow("getViews");
  });

  it("says a call needs a user gesture when Firefox refuses it for that reason", async () => {
    await expect(setup().browser.permissions.request({ permissions: ["x"] })).rejects.toThrow(/browser.permissions.request needs a user gesture/);
  });
});

describe("F7 calls that depend on the caller's tab answer for the framed page", () => {
  it("tabs.getCurrent() is the host tab, with the framed page's URL", async () => {
    await expect(setup().browser.tabs.getCurrent()).resolves.toEqual({ id: 1, windowId: 3, url: `${BASE}app.html` });
  });

  it("a host tab in any result has the framed page's URL", async () => {
    const { browser } = setup();
    expect((await browser.tabs.query({}))[1].url).toBe(`${BASE}app.html`);
    expect((await browser.tabs.get(1)).url).toBe(`${BASE}app.html`);
    expect((await browser.tabs.get(7)).url).toBe("https://x.test/");
  });

  it("currentWindow and windows.getCurrent() mean the sender's window", async () => {
    const { browser, calls } = setup();
    await browser.tabs.query({ active: true, currentWindow: true });
    await expect(browser.windows.getCurrent({ populate: false })).resolves.toEqual({ id: 3 });
    expect(calls).toEqual([["tabs.query", { active: true, windowId: 3 }], ["windows.get", 3, { populate: false }]]);
  });
});

describe("F8 an argument that cannot cross the relay fails loudly and names the API", () => {
  it("rejects a function argument before it posts, with the API, the argument path and what to do instead", async () => {
    const { browser, calls } = setup();
    const call = browser.tabs.query({ active: true, filter: () => true });
    await expect(call).rejects.toThrow(/browser\.tabs\.query: args\[0\]\.filter is a function/);
    await expect(call).rejects.toThrow(/files|locally/);
    expect(calls).toEqual([]);
  });

  it("names scripting.executeScript details.func, the case foxpaw hit", async () => {
    const scripting = framePlan({ permissions: ["scripting"] });
    const { browser } = setup({ framePlanned: scripting });
    await expect(browser.scripting.executeScript({ target: { tabId: 7 }, func: () => document.title, args: [] })).rejects.toThrow(
      /browser\.scripting\.executeScript: args\[0\]\.func is a function.*files/s,
    );
  });

  it("throws in addListener when an extra listener argument cannot cross", () => {
    const { browser } = setup();
    expect(() => browser.tabs.onUpdated.addListener(() => {}, { match: () => true })).toThrow(/browser\.tabs\.onUpdated\.addListener: extra\[0\]\.match is a function/);
  });

  it("rejects a result the relay cannot send back, and names the API", async () => {
    await expect(setup().browser.tabs.get(99)).rejects.toThrow(/browser\.tabs\.get: the result cannot cross the frame relay/);
  });
});

describe("F9 storage.session in a framed page", () => {
  it("fills storage.session with relayed calls, its event and QUOTA_BYTES when the manifest grants storage", async () => {
    const { browser, calls } = setup();
    expect(browser.storage.local).toEqual({});
    expect(browser.storage.session.QUOTA_BYTES).toBe(10485760);
    const seen: unknown[] = [];
    browser.storage.session.onChanged.addListener((changes: unknown) => seen.push(changes));
    await new Promise((done) => setTimeout(done, 10));
    await browser.storage.session.set({ tab: 4 });
    await expect(browser.storage.session.get("tab")).resolves.toEqual({ tab: 4 });
    await new Promise((done) => setTimeout(done, 10));
    expect(seen).toEqual([{ tab: { newValue: 4 } }]);
    expect(calls).toEqual([["storage.session.get", "tab"]]);
  });

  it("leaves a frame that has storage.session alone, and adds nothing without the storage permission", () => {
    expect(setup({ session: true }).browser.storage.session).toEqual({ real: true });
    const bare = framePlan({ permissions: ["tabs"] });
    expect(bare.relayed).not.toContain("storage.session");
    expect(setup({ framePlanned: bare }).browser.storage.session).toBeUndefined();
  });
});

describe("R9 a handshake that never ends", () => {
  const saved = { ...process.env };
  let sockets: Socket[] = [];
  afterEach(() => {
    process.env = { ...saved };
    for (const s of sockets) s.destroy();
    sockets = [];
  });

  it("gives up after 3 tries with a limit on each, and says the service may be busy", async () => {
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    process.env.ICHABOD_API_KEY = "k";
    process.env.ICHABOD_HOST = `127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "foxkit-frame-test-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, browser_specific_settings: { gecko: { id: "a@b" } } }));
    const started = Date.now();
    await expect(connectIchabod({ extension: dir, host: HOST, connectTimeoutMs: 300, retryDelayMs: 10 })).rejects.toThrow(/3 tries.*busy/s);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sockets).toHaveLength(3);
    server.close();
  });
});
