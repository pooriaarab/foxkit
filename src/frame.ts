// The frame host: how openExtensionPage() works on Ichabod.
//
// Ichabod's Firefox runs without -remote-allow-system-access, so BiDi cannot
// script or capture a moz-extension: page in a tab. It can do both when the
// page is in an iframe on an https page. So openExtensionPage() frames it on
// the frame host, a page mounted on the shared tunnel (src/tunnel.ts). A
// framed page gets only runtime, storage and i18n, so the remote zip adds:
// - foxkit-frame.js, first in each extension page: in a frame, it fills the
//   namespaces the frame lacks and the manifest grants (F1) with calls to
//   the background page over a port.
// - foxkit-relay.js, a background script: it runs those calls (F2) for this
//   extension's pages framed on the frame host only (F3). Calls about "my
//   tab" answer for the frame, and a host tab shows the framed URL (F7).
// A granted namespace the relay does not cover throws (F6). An argument
// that cannot cross the port (a function) rejects and names the API (F8).
// storage.session, which a framed page lacks, is relayed (F9).
// docs/failure-modes.md F1-F9.
import type { Frame, Page } from "puppeteer-core";

export const SHIM_SCRIPT = "foxkit-frame.js";
export const RELAY_SCRIPT = "foxkit-relay.js";
export const RELAY_PORT = "foxkit-relay";

// The relayed namespaces: those every page has, those a manifest key grants, and those a permission grants.
const ALWAYS = ["tabs", "windows", "permissions"];
const BY_KEY: Record<string, string> = { action: "action", sidebar_action: "sidebarAction", browser_action: "browserAction", page_action: "pageAction" };
const RELAYED_PERMISSIONS = ["alarms", "bookmarks", "browsingData", "contextualIdentities", "cookies", "downloads", "history", "notifications", "scripting", "sessions", "topSites", "webNavigation"];
/** Permission names that are not a namespace, or that a framed page already has. */
const NOT_NAMESPACES = new Set(["storage", "unlimitedStorage", "activeTab", "webRequestBlocking", "nativeMessaging", "menus", "contextMenus", "clipboardRead", "clipboardWrite", "geolocation", "background", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback", "tabHide", "mozillaAddons"]);
/** Constants a page reads without a call. */
const CONSTANTS: Record<string, Record<string, number>> = { tabs: { TAB_ID_NONE: -1 }, windows: { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 }, "storage.session": { QUOTA_BYTES: 10485760 } };

export interface FramePlan {
  /** Namespaces the shim fills with relayed calls. A dotted name (storage.session) fills a member of a real namespace. */
  relayed: string[];
  /** Granted namespaces the shim does not relay: they throw on access (F6). */
  blocked: string[];
}

interface Manifest {
  permissions?: unknown[];
  optional_permissions?: unknown[];
  [key: string]: unknown;
}

/** Which namespaces the frame shim relays (F1) and which it blocks (F6), from the manifest. */
export function framePlan(manifest: Manifest): FramePlan {
  const relayed = new Set(ALWAYS);
  for (const [key, ns] of Object.entries(BY_KEY)) if (manifest[key]) relayed.add(ns);
  const blocked = new Set<string>();
  for (const permission of [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])]) {
    if (typeof permission !== "string" || NOT_NAMESPACES.has(permission)) continue;
    if (RELAYED_PERMISSIONS.includes(permission)) relayed.add(permission);
    else blocked.add(permission);
  }
  // F9: a framed page has storage, but not storage.session.
  if (manifest.permissions?.includes("storage")) relayed.add("storage.session");
  for (const ns of relayed) blocked.delete(ns);
  return { relayed: [...relayed].toSorted(), blocked: [...blocked].toSorted() };
}

/** foxkit-frame.js for this manifest and the frame host URL. */
export function shimScript(plan: FramePlan, hostUrl: string): string {
  const config = JSON.stringify({ host: new URL(hostUrl).origin, port: RELAY_PORT, relayed: plan.relayed, blocked: plan.blocked, constants: CONSTANTS });
  return `// Added by create-foxkit/e2e in remote mode only (docs/failure-modes.md F1-F3, F6).
(() => {
  const C = ${config};
  if (window.top === window || typeof browser !== "object") return;
  if (location.ancestorOrigins && location.ancestorOrigins[location.ancestorOrigins.length - 1] !== C.host) return;
  const pending = new Map();
  const events = new Map();
  let port = null;
  let seq = 0;
  let refused = "";
  const fail = (text) => new Error("create-foxkit frame relay: " + text);
  // F8: the path of the first value a port cannot clone, or "".
  const uncloneable = (value, at, seen = new Set()) => {
    if (typeof value === "function") return at + " is a function";
    if (typeof value === "symbol") return at + " is a symbol";
    if (!value || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    if (typeof Node === "function" && value instanceof Node) return at + " is a DOM node";
    if (typeof Window === "function" && value instanceof Window) return at + " is a window";
    for (const [k, v] of Object.entries(value)) {
      const found = uncloneable(v, at + (Array.isArray(value) ? "[" + k + "]" : "." + k), seen);
      if (found) return found;
    }
    return "";
  };
  const crossFail = (name, found) => fail(name + ": " + found + ", and it cannot cross the frame relay to the background page. The background page cannot rebuild a function: Manifest V3 blocks eval there. For scripting.executeScript, pass files instead of func, or run this check locally (FOXKIT_BROWSER unset).");
  const connect = () => {
    if (port) return port;
    port = browser.runtime.connect({ name: C.port });
    port.onMessage.addListener((m) => {
      if (m.refused) refused = m.refused;
      if (m.event) for (const fn of events.get(m.event) || []) fn(...m.args);
      const call = m.id && pending.get(m.id);
      if (call) pending.delete(m.id), "error" in m ? call.reject(new Error(m.error)) : call.resolve(m.value);
    });
    port.onDisconnect.addListener(() => {
      const error = fail(refused || "the background page closed the relay port.");
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      events.clear();
      port = null;
    });
    return port;
  };
  const send = (message) => new Promise((resolve, reject) => {
    pending.set(++seq, { resolve, reject });
    connect().postMessage({ id: seq, ...message });
  });
  const event = (ns, member) => {
    const name = ns + "." + member;
    return {
      addListener(fn, ...extra) {
        if (typeof fn !== "function") throw fail(name + ".addListener needs a function.");
        const found = uncloneable(extra, "extra");
        if (found) throw crossFail("browser." + name + ".addListener", found);
        if (!events.has(name)) {
          events.set(name, new Set());
          send({ sub: name, ns, member, extra }).catch((error) => console.error(error));
        }
        events.get(name).add(fn);
      },
      removeListener: (fn) => events.get(name)?.delete(fn),
      hasListener: (fn) => Boolean(events.get(name)?.has(fn)),
    };
  };
  const namespace = (ns) => {
    const made = new Map();
    return new Proxy({}, {
      get(_, member) {
        if (typeof member !== "string" || member === "then") return undefined;
        const constants = C.constants[ns] || {};
        if (member in constants) return constants[member];
        const call = (...args) => {
          const found = uncloneable(args, "args");
          return found ? Promise.reject(crossFail("browser." + ns + "." + member, found)) : send({ call: true, ns, member, args });
        };
        if (!made.has(member)) made.set(member, /^on[A-Z]/.test(member) ? event(ns, member) : call);
        return made.get(member);
      },
    });
  };
  for (const ns of C.relayed) {
    const [head, member] = ns.split(".");
    if (!member) {
      if (!(ns in browser)) browser[ns] = namespace(ns);
    } else if (browser[head] && browser[head][member] == null) {
      Object.defineProperty(browser[head], member, { configurable: true, enumerable: true, value: namespace(ns) });
    }
  }
  for (const ns of C.blocked) {
    if (ns in browser) continue;
    Object.defineProperty(browser, ns, { configurable: true, get() { throw fail("browser." + ns + " is granted but not relayed into a framed page. Run this check locally, or add the namespace to create-foxkit's frame relay."); } });
  }
  if (browser.extension && typeof browser.extension.getViews !== "function") {
    browser.extension.getViews = (filter = {}) => {
      if (filter && (filter.type === "sidebar" || filter.type === "popup") && Object.keys(filter).length === 1) return [];
      throw fail("extension.getViews() answers only { type: \\"sidebar\\" } and { type: \\"popup\\" } in a framed page.");
    };
  }
})();
`;
}

/** foxkit-relay.js: the background half. It runs calls for framed pages on the frame host only. */
export function relayScript(plan: FramePlan, hostUrl: string): string {
  const config = JSON.stringify({ host: hostUrl.replace(/\/$/, ""), port: RELAY_PORT, relayed: plan.relayed });
  return `// Added by create-foxkit/e2e in remote mode only (docs/failure-modes.md F2, F3).
(() => {
  const C = ${config};
  const base = browser.runtime.getURL("");
  const GESTURE = /user input handler|user action|user gesture/i;
  // F7: each frame host tab stands for the extension page framed in it.
  const framed = new Map();
  const asFramed = (value) => {
    if (Array.isArray(value)) return value.map(asFramed);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = asFramed(v);
    if (typeof out.id === "number" && typeof out.url === "string" && framed.has(out.id)) out.url = framed.get(out.id);
    return out;
  };
  // F7: calls that mean "my tab" or "my window" answer for the sender.
  const inContext = (m, sender) => {
    const tab = sender.tab;
    if (m.ns === "tabs" && m.member === "getCurrent") return () => Promise.resolve(tab);
    if (m.ns === "windows" && m.member === "getCurrent") return (info) => browser.windows.get(tab.windowId, info);
    if (m.ns === "tabs" && m.member === "query" && m.args[0] && m.args[0].currentWindow === true) {
      const { currentWindow, ...rest } = m.args[0];
      return () => browser.tabs.query({ ...rest, windowId: tab.windowId });
    }
    return undefined;
  };
  const allowed = (sender) => {
    try {
      return sender.id === browser.runtime.id && String(sender.url).startsWith(base) && sender.frameId !== 0 && sender.tab && String(sender.tab.url).startsWith(C.host + "/");
    } catch {
      return false;
    }
  };
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== C.port) return;
    if (!allowed(port.sender)) {
      port.postMessage({ refused: "the relay answers only this extension's pages framed on " + C.host + "." });
      port.disconnect();
      return;
    }
    const off = [];
    framed.set(port.sender.tab.id, port.sender.url);
    port.onDisconnect.addListener(() => {
      if (framed.get(port.sender.tab.id) === port.sender.url) framed.delete(port.sender.tab.id);
      off.splice(0).forEach((fn) => fn());
    });
    port.onMessage.addListener(async (m) => {
      const name = "browser." + m.ns + "." + m.member;
      try {
        if (!C.relayed.includes(m.ns)) throw new Error("browser." + m.ns + " is not relayed.");
        const owner = m.ns.split(".").reduce((o, k) => (o ? o[k] : undefined), browser);
        const target = owner && owner[m.member];
        if (m.sub) {
          if (!target || typeof target.addListener !== "function") throw new Error(name + " is not an event in this Firefox.");
          const fn = (...args) => port.postMessage({ event: m.sub, args: asFramed(args) });
          target.addListener(fn, ...(m.extra || []));
          off.push(() => target.removeListener(fn));
          port.postMessage({ id: m.id, value: true });
        } else if (m.call) {
          if (typeof target !== "function") throw new Error(name + " is not a function in this Firefox.");
          const run = inContext(m, port.sender) || ((...args) => target.apply(owner, args));
          const value = asFramed(await run(...m.args));
          try {
            port.postMessage({ id: m.id, value });
          } catch (error) {
            throw new Error(name + ": the result cannot cross the frame relay: " + (error instanceof Error ? error.message : String(error)));
          }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        port.postMessage({ id: m.id, error: GESTURE.test(text) ? name + " needs a user gesture, and a relayed call has none: " + text : text });
      }
    });
  });
})();
`;
}

/** The page with the shim as its first script. The shim must run before the page's own scripts. */
export function injectShim(html: string): string {
  const tag = `<script src="/${SHIM_SCRIPT}"></script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length) : tag + html;
}

/** The frame host page: one iframe that fills the window. */
export const HOST_PAGE = `<!doctype html><meta charset="utf-8"><title>create-foxkit frame host</title>
<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100vw;height:100vh}</style>
`;

const TO_FRAME = new Set(["evaluate", "evaluateHandle", "$", "$$", "$eval", "$$eval", "click", "focus", "hover", "select", "tap", "type", "waitForSelector", "waitForFunction", "title", "content", "locator"]);

/**
 * A Page whose DOM calls go to the extension frame and whose tab calls
 * (screenshot, close, bringToFront, keyboard, mouse) go to the host tab.
 * url() returns the extension URL it opened.
 */
export function framedPage(page: Page, frame: Frame, url: string): Page {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === "url") return () => url;
      if (prop === "mainFrame") return () => frame;
      const owner: object = typeof prop === "string" && TO_FRAME.has(prop) ? frame : target;
      const value = Reflect.get(owner, prop, owner) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(owner) : value;
    },
  });
}
