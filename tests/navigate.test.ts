// Tests for R10 in docs/failure-modes.md: a navigation in remote mode that
// times out or hits a network error. A fake page stands in for Puppeteer.
import { describe, expect, it, vi } from "vitest";
import { navigator, REMOTE_NAVIGATION_TIMEOUT_MS } from "../src/navigate.js";

const PAGE_URL = "https://x.trycloudflare.com/_foxkit/1/signup.html";

function timeout(ms = REMOTE_NAVIGATION_TIMEOUT_MS) {
  return Object.assign(new Error(`Navigation timeout of ${ms} ms exceeded`), { name: "TimeoutError" });
}

/** A page whose goto() answers with each outcome in turn: an Error rejects, anything else resolves. */
function fakePage(...outcomes: unknown[]) {
  const calls: Array<{ url: string; options: unknown }> = [];
  return {
    calls,
    goto: vi.fn(async (url: string, options?: unknown) => {
      calls.push({ url, options });
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return null;
    }),
  };
}

describe("R10 remote mode navigates with a 60 s limit and one more try", () => {
  it("uses a 60 s timeout and waits for load", async () => {
    const page = fakePage(null);
    await navigator("ichabod", () => {})(page, PAGE_URL);
    expect(REMOTE_NAVIGATION_TIMEOUT_MS).toBe(60_000);
    expect(page.calls).toEqual([{ url: PAGE_URL, options: { waitUntil: "load", timeout: 60_000 } }]);
  });

  it("tries once more after a timeout, and logs one line that names the URL and the error", async () => {
    const page = fakePage(timeout(), null);
    const log = vi.fn();
    await navigator("ichabod", log)(page, PAGE_URL);
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain(PAGE_URL);
    expect(line).toContain("Navigation timeout of 60000 ms exceeded");
    expect(line).toMatch(/once more/);
  });

  it.each(["NS_ERROR_NET_RESET", "NS_ERROR_NET_TIMEOUT", "NS_ERROR_NET_INTERRUPT", "NS_ERROR_CONNECTION_REFUSED", "NS_ERROR_UNKNOWN_HOST", "net::ERR_CONNECTION_RESET"])(
    "tries once more after the network error %s",
    async (code) => {
      const page = fakePage(new Error(`${code} at ${PAGE_URL}`), null);
      const log = vi.fn();
      await navigator("ichabod", log)(page, PAGE_URL);
      expect(page.goto).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledTimes(1);
    },
  );

  it("stops after the second failure, with an error that names the URL and both errors", async () => {
    const page = fakePage(timeout(), new Error("NS_ERROR_NET_RESET"), null);
    const error = await navigator("ichabod", () => {})(page, PAGE_URL).then(
      () => new Error("navigated"),
      (e: unknown) => e as Error,
    );
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(error.message).toContain(PAGE_URL);
    expect(error.message).toContain("Navigation timeout of 60000 ms exceeded");
    expect(error.message).toContain("NS_ERROR_NET_RESET");
  });

  it("does not try again after an error that a second try cannot fix", async () => {
    const wrong = new Error("NS_ERROR_MALFORMED_URI");
    const page = fakePage(wrong, null);
    const log = vi.fn();
    await expect(navigator("ichabod", log)(page, PAGE_URL)).rejects.toBe(wrong);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("R10 local mode does not change", () => {
  it("navigates once with Puppeteer's default timeout, and a timeout fails at once", async () => {
    const failed = timeout(30_000);
    const page = fakePage(failed, null);
    const log = vi.fn();
    await expect(navigator("local", log)(page, PAGE_URL)).rejects.toBe(failed);
    expect(page.calls).toEqual([{ url: PAGE_URL, options: { waitUntil: "load" } }]);
    expect(log).not.toHaveBeenCalled();
  });
});
