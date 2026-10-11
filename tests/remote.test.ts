// Tests for remote mode that need no network and no Ichabod: R1 (launch),
// R2, R3, R4 and R6 (the zip) in docs/failure-modes.md.
// scripts/e2e-ichabod.mjs covers the rest against the real service.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launch, writeArtifact } from "../src/e2e.js";
import { remoteExtensionZip } from "../src/ichabod.js";

const KEY = "test-key-5b1d0c9e";
const saved = { ...process.env };
let dir = "";
let extension = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "foxkit-remote-test-"));
  extension = join(dir, "ext");
  mkdirSync(join(extension, "lib"), { recursive: true });
  writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, browser_specific_settings: { gecko: { id: "a@b" } }, background: { scripts: ["bg.js"] } }));
  writeFileSync(join(extension, "bg.js"), "// background\n");
  writeFileSync(join(extension, "lib", "deep.js"), "// nested\n");
  delete process.env.FOXKIT_BROWSER;
  delete process.env.ICHABOD_API_KEY;
  delete process.env.ICHABOD_HOST;
});
afterEach(() => {
  process.env = { ...saved };
});

const closedPort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

function unzip(zip: Buffer, file?: string) {
  const path = join(dir, "out.zip");
  writeFileSync(path, zip);
  return execFileSync("unzip", file ? ["-p", path, file] : ["-Z1", path], { encoding: "utf8" });
}

describe("R1 an unknown FOXKIT_BROWSER value never launches locally", () => {
  it.each(["ichbod", "ichabod ", "ICHABOD", "remote"])("refuses %j", async (value) => {
    process.env.FOXKIT_BROWSER = value;
    await expect(launch({ extension })).rejects.toThrow(JSON.stringify(value));
    await expect(launch({ extension })).rejects.toThrow(/"ichabod" or "local"/);
  });
});

describe("launch() in remote mode refuses before it connects", () => {
  it("R2 names a missing ICHABOD_API_KEY", async () => {
    process.env.FOXKIT_BROWSER = "ichabod";
    await expect(launch({ extension })).rejects.toThrow("ICHABOD_API_KEY");
    delete process.env.FOXKIT_BROWSER;
    await expect(launch({ extension, remote: "ichabod" })).rejects.toThrow("ICHABOD_API_KEY");
  });

  it.each([
    ["prefs", { prefs: { "a.b": 1 } }],
    ["firefox", { firefox: "/usr/bin/firefox" }],
    ["headless", { headless: false }],
  ])("R3 refuses the %s option", async (name, option) => {
    process.env.ICHABOD_API_KEY = KEY;
    await expect(launch({ extension, remote: "ichabod", ...option })).rejects.toThrow(name);
  });
});

describe("R4 the key stays out of errors and artifacts", () => {
  it("a failed connection names neither the key nor its Basic form", async () => {
    process.env.ICHABOD_API_KEY = KEY;
    process.env.ICHABOD_HOST = `127.0.0.1:${await closedPort()}`;
    const error = await launch({ extension, remote: "ichabod" }).then(
      () => new Error("connected"),
      (e: unknown) => e as Error,
    );
    const text = `${error.message}\n${error.stack}`;
    expect(text).toContain("Ichabod");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(Buffer.from(`api:${KEY}`).toString("base64"));
  });

  it("writeArtifact() replaces the key with ***", () => {
    process.env.ICHABOD_API_KEY = KEY;
    const path = writeArtifact(dir, "r4", { error: `wss://api:${KEY}@host failed` });
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).error).toBe("wss://api:***@host failed");
  });
});

describe("R6 the remote copy of the extension", () => {
  it("adds the UUID script and keeps every file, and leaves the directory alone", () => {
    const before = readFileSync(join(extension, "manifest.json"), "utf8");
    const zip = remoteExtensionZip(extension);
    expect(unzip(zip).split("\n").filter(Boolean).toSorted()).toEqual(["bg.js", "foxkit-uuid.html", "foxkit-uuid.js", "lib/deep.js", "manifest.json"]);
    expect(JSON.parse(unzip(zip, "manifest.json")).background.scripts).toEqual(["bg.js", "foxkit-uuid.js"]);
    expect(unzip(zip, "lib/deep.js")).toBe("// nested\n");
    expect(readFileSync(join(extension, "manifest.json"), "utf8")).toBe(before);
  });

  it("adds a background when the extension has none", () => {
    writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, browser_specific_settings: { gecko: { id: "a@b" } } }));
    expect(JSON.parse(unzip(remoteExtensionZip(extension), "manifest.json")).background).toEqual({ scripts: ["foxkit-uuid.js"] });
  });

  it("refuses a background page, which it cannot add a script to", () => {
    writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 2, browser_specific_settings: { gecko: { id: "a@b" } }, background: { page: "bg.html" } }));
    expect(() => remoteExtensionZip(extension)).toThrow("background.page");
  });
});
