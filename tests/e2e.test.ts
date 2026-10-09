// Tests for the harness failure modes that need no Firefox: H1, H2, H5, H8,
// H9 and H10 in docs/failure-modes.md. scripts/e2e.mjs covers the rest in a
// real Firefox.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launch, poll, serve, writeArtifact } from "../src/e2e.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foxkit-e2e-test-"));
});

describe("launch() refuses before it starts Firefox", () => {
  it("H1 names a missing Firefox and the FIREFOX variable", async () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ browser_specific_settings: { gecko: { id: "a@b" } } }));
    const missing = join(dir, "no-firefox");
    await expect(launch({ extension: dir, firefox: missing })).rejects.toThrow(missing);
    await expect(launch({ extension: dir, firefox: missing })).rejects.toThrow("FIREFOX");
  });

  it("H2 names a missing manifest.json", async () => {
    await expect(launch({ extension: dir, firefox: process.execPath })).rejects.toThrow(join(dir, "manifest.json"));
  });

  it("H2 names a manifest without a gecko ID", async () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
    await expect(launch({ extension: dir, firefox: process.execPath })).rejects.toThrow("browser_specific_settings.gecko.id");
  });
});

describe("poll()", () => {
  it("H5 throws after the timeout and names it", async () => {
    const page = { evaluate: async () => false };
    await expect(poll(page, () => false, undefined, 300)).rejects.toThrow("300 ms");
  });

  it("returns the first truthy value", async () => {
    let calls = 0;
    const page = { evaluate: async () => (++calls >= 2 ? "ready" : null) };
    expect(await poll(page, () => null, undefined, 5000)).toBe("ready");
  });
});

describe("serve()", () => {
  let site: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => site?.close());

  it("serves a file in its directory", async () => {
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site", "index.html"), "<p>hi</p>");
    site = await serve(join(dir, "site"));
    const res = await fetch(`${site.url}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<p>hi</p>");
  });

  it("H8 answers 404 for a path outside its directory", async () => {
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "secret.txt"), "no");
    site = await serve(join(dir, "site"));
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"]) {
      expect((await fetch(`${site.url}${path}`)).status, path).toBe(404);
    }
  });

  it("H9 answers 404 for a file that does not exist", async () => {
    site = await serve(dir);
    expect((await fetch(`${site.url}/nothing.html`)).status).toBe(404);
  });
});

describe("writeArtifact()", () => {
  it("H10 creates the directory and writes <name>-<date>.json", () => {
    const out = join(dir, "artifacts", "deep");
    const path = writeArtifact(out, "e2e", { passed: true });
    const today = new Date().toISOString().slice(0, 10);
    expect(path).toBe(join(out, `e2e-${today}.json`));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ passed: true });
  });
});
