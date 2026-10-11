// Tests for the frame host that need no network: F1-F3 in
// docs/failure-modes.md. The shim and the relay run in node:vm with a fake
// browser object. scripts/e2e-ichabod.mjs runs them in a real Firefox.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { framePlan, relayScript, shimScript } from "../src/frame.js";

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
  const page = { name, onMessage: pageIn, onDisconnect: pageGone, postMessage: (m: unknown) => queueMicrotask(() => bgIn.emit(clone(m))) };
  const bg = { name, sender, onMessage: bgIn, onDisconnect: bgGone, postMessage: (m: unknown) => queueMicrotask(() => pageIn.emit(clone(m))), disconnect: () => queueMicrotask(() => pageGone.emit()) };
  return { page, bg };
}

/** A fake background page with the relay script loaded, and a framed page with the shim. */
function setup({ top = false, ancestor = ORIGIN, sender = {} as Record<string, unknown>, has = [] as string[] } = {}) {
  const onConnect = listeners();
  const onUpdated = listeners();
  const calls: unknown[][] = [];
  const bgBrowser = {
    runtime: { id: "a@b", getURL: (p: string) => BASE + p, onConnect },
    tabs: { query: async (q: unknown) => (calls.push(["tabs.query", q]), [{ id: 7, url: "https://x.test/" }]), onUpdated },
  };
  runInNewContext(relayScript(plan, HOST), { browser: bgBrowser, URL });
  const fullSender = { id: "a@b", url: `${BASE}app.html`, frameId: 5, tab: { id: 1, url: `${HOST}/` }, ...sender };
  const pageBrowser: Record<string, unknown> = {
    runtime: { connect: ({ name }: { name: string }) => {
      const { page, bg } = portPair(name, fullSender);
      onConnect.emit(bg);
      return page;
    } },
    storage: { local: {} },
    extension: {},
  };
  for (const ns of has) pageBrowser[ns] = { real: true };
  const window: Record<string, unknown> = {};
  window.top = top ? window : {};
  runInNewContext(shimScript(plan, HOST), { browser: pageBrowser, window, location: { ancestorOrigins: [ancestor] }, console });
  return { browser: pageBrowser as Record<string, any>, calls, onUpdated };
}

describe("F1 the shim adds only what the real page has and the frame lacks", () => {
  it("fills tabs, windows, permissions, sidebarAction and the granted notifications in a frame, and nothing else", () => {
    expect(plan.relayed).toEqual(["notifications", "permissions", "sidebarAction", "tabs", "windows"]);
    const { browser } = setup();
    for (const ns of plan.relayed) expect(typeof browser[ns]).toBe("object");
    for (const ns of ["alarms", "cookies", "action", "bookmarks", "webRequest"]) expect(ns in browser).toBe(false);
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
    await expect(browser.tabs.query({ active: true })).resolves.toEqual([{ id: 7, url: "https://x.test/" }]);
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
