// How open() and the frame host navigate. docs/failure-modes.md R10.
//
// On Ichabod a navigation is slow when the session is slow: in a slow
// session one load took 38 s while the gateway answered in 5 ms. Puppeteer's
// 30 s default then fails a test that a rerun passes. Remote mode allows
// 60 s and tries once more after a timeout or a network error. Local mode
// does not change.
import type { BrowserMode } from "./mode.js";

export const REMOTE_NAVIGATION_TIMEOUT_MS = 60_000;

/** The part of a Puppeteer Page that navigate needs. */
export interface Navigable {
  goto(url: string, options: { waitUntil: "load"; timeout?: number }): Promise<unknown>;
}

export type Navigate = (page: Navigable, url: string) => Promise<void>;

// A timeout, or a network error that a second try can fix. Firefox names
// these NS_ERROR_*; Chromium names them net::ERR_*.
const RETRYABLE = /Navigation timeout of \d+ ms exceeded|NS_ERROR_NET_|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_UNKNOWN_HOST|NS_ERROR_PROXY_|net::ERR_/;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function retryable(error: unknown): boolean {
  return (error instanceof Error && error.name === "TimeoutError") || RETRYABLE.test(message(error));
}

/** The navigation for a mode. log gets the one line remote mode writes before its second try. */
export function navigator(mode: BrowserMode, log: (line: string) => void = console.error): Navigate {
  if (mode === "local") {
    return async (page, url) => {
      await page.goto(url, { waitUntil: "load" });
    };
  }
  return async (page, url) => {
    const options = { waitUntil: "load", timeout: REMOTE_NAVIGATION_TIMEOUT_MS } as const;
    const started = Date.now();
    try {
      await page.goto(url, options);
      return;
    } catch (error) {
      if (!retryable(error)) throw error;
      log(`foxkit: navigation to ${url} failed after ${Math.round((Date.now() - started) / 1000)} s on Ichabod (${message(error)}); trying once more.`);
      try {
        await page.goto(url, options);
      } catch (again) {
        throw new Error(`Navigation to ${url} failed twice on Ichabod. First: ${message(error)} Then: ${message(again)}`, { cause: again });
      }
    }
  };
}
