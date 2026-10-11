// The remote-mode E2E: create-foxkit/e2e against the real Ichabod service
// and a real Cloudflare quick tunnel. It checks R4-R8, T3, T4 and F2-F7 in
// docs/failure-modes.md and writes artifacts/e2e-ichabod-<date>.json.
//
// Usage: pnpm e2e:ichabod (it builds first). Env: ICHABOD_API_KEY.
// Needs cloudflared and the network.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTunnels, launch, poll, serve, tunnel, writeArtifact } from "../dist/e2e.js";

process.env.FOXKIT_BROWSER = "ichabod";
const record = { startedAt: new Date().toISOString(), steps: [] };
const check = (name, ok, detail) => {
  record.steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "ok " : "BAD"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const tunnels = () => {
  try {
    return execFileSync("pgrep", ["-f", "cloudflared tunnel --no-autoupdate --grace-period 1s --url http://127.0.0.1:"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

// A fixture extension: its content script writes the real extension base URL
// into each page, so the test can compare it with extensionUrl().
const work = mkdtempSync(join(tmpdir(), "foxkit-ichabod-"));
const extension = join(work, "ext");
const site = join(work, "site");
mkdirSync(extension);
mkdirSync(site);
writeFileSync(join(extension, "manifest.json"), JSON.stringify({
  manifest_version: 3,
  name: "foxkit remote fixture",
  version: "1.0",
  browser_specific_settings: { gecko: { id: "remote-fixture@foxkit" } },
  permissions: ["tabs", "storage", "scripting", "privacy"],
  host_permissions: ["<all_urls>"],
  background: { scripts: ["bg.js"] },
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
}));
writeFileSync(join(extension, "content.js"), 'document.documentElement.dataset.foxkit = browser.runtime.getURL("");\n');
writeFileSync(join(extension, "bg.js"), 'browser.runtime.onMessage.addListener((m) => (m === "ping" ? Promise.resolve("pong") : m === "session" ? browser.storage.session.get("s") : undefined));\n');
writeFileSync(join(extension, "page.html"), '<!doctype html><title>fixture page</title><button id="b">press</button><script src="page.js"></script>\n');
writeFileSync(join(extension, "page.js"), 'document.getElementById("b").addEventListener("click", (e) => { e.target.textContent = "pressed"; });\nwindow.created = [];\nbrowser.tabs.onCreated.addListener((tab) => window.created.push(tab.id));\n');
writeFileSync(join(site, "index.html"), "<!doctype html><title>foxkit remote</title><h1>Remote</h1>\n");

const before = tunnels();
let server;
let fox;
try {
  let started = Date.now();
  server = await serve(site);
  check("serve() returns a public URL on the shared tunnel", /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/_foxkit\/\d+$/.test(server.url), { ms: Date.now() - started, url: server.url });

  started = Date.now();
  fox = await launch({ extension });
  record.firefox = await fox.browser.version();
  check("launch() connects to Ichabod and installs the extension", true, { ms: Date.now() - started, firefox: record.firefox });
  const extra = await tunnel(9);
  await extra.close();
  check("T4 serve(), the frame host and one more tunnel() share one cloudflared", tunnels() === before + 1, { before, during: tunnels() });

  const page = await fox.open(`${server.url}/index.html`);
  check("the cloud browser loads the page through the tunnel", (await page.title()) === "foxkit remote");
  const real = await poll(page, () => document.documentElement.dataset.foxkit, undefined, 15_000);
  check("R6 extensionUrl() has the real moz-extension: UUID", real === fox.extensionUrl(), { real, extensionUrl: fox.extensionUrl() });
  check("a screenshot of a web page works", (await page.screenshot()).length > 1000);

  started = Date.now();
  const ext = await fox.openExtensionPage("page.html");
  check("R7 openExtensionPage() opens the extension page in a frame BiDi can script", (await ext.evaluate(() => location.href)) === fox.extensionUrl("page.html") && (await ext.title()) === "fixture page", { ms: Date.now() - started });
  check("the framed page reaches the real background and storage", await ext.evaluate(async () => (await browser.runtime.sendMessage("ping")) === "pong" && (await browser.storage.local.set({ k: 1 }), (await browser.storage.local.get("k")).k === 1)));
  const tabs = await ext.evaluate(async () => (await browser.tabs.query({})).map((t) => t.url));
  check("F2 a relayed tabs.query() sees the real tabs", tabs.some((u) => u?.startsWith(server.url)), tabs);
  const current = await ext.evaluate(async () => (await browser.tabs.getCurrent())?.url);
  check("F7 tabs.getCurrent() is the frame's tab, with the extension page URL", current === fox.extensionUrl("page.html"), current);
  const created = await ext.evaluate(async () => (await browser.tabs.create({ url: "about:blank", active: false })).id);
  const events = await poll(ext, () => window.created.length > 0 && window.created, undefined, 10_000).catch(() => []);
  check("F2 a relayed event (tabs.onCreated) reaches the page", events.includes(created), { created, events });
  const gesture = await ext.evaluate(() => browser.permissions.request({ permissions: ["bookmarks"] }).then(() => "granted", (e) => e.message));
  check("F6 a call that needs a user gesture fails and says so", /needs a user gesture/.test(gesture), gesture);
  const blocked = await ext.evaluate(() => {
    try {
      return typeof browser.privacy;
    } catch (error) {
      return error.message;
    }
  });
  check("F6 a granted namespace the relay does not cover throws", /browser.privacy is granted but not relayed/.test(blocked), blocked);
  const session = await ext.evaluate(async () => {
    await browser.storage.session.set({ s: "framed" });
    return { own: (await browser.storage.session.get("s")).s, background: (await browser.runtime.sendMessage("session")).s };
  });
  check("F9 storage.session in the framed page is the real session area", session.own === "framed" && session.background === "framed", session);
  const func = await ext.evaluate(() => browser.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 }).then(() => "answered", (e) => e.message));
  check("F8 a function argument rejects and names the API and the argument", /browser\.scripting\.executeScript: args\[0\]\.func is a function/.test(func), func);
  await ext.click("#b");
  check("a click in the framed page works", (await ext.evaluate(() => document.getElementById("b").textContent)) === "pressed");
  check("a screenshot of the framed page works", (await ext.screenshot()).length > 1000);
  // F3: the serve() site shares the tunnel origin, so Firefox lets it frame the page; the relay must refuse it.
  await page.evaluate((u) => {
    const frame = document.createElement("iframe");
    frame.src = u;
    document.body.append(frame);
  }, fox.extensionUrl("page.html"));
  let refused = "no frame";
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && refused === "no frame"; ) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const loaded = await frame.evaluate(() => location.protocol === "moz-extension:").catch(() => false);
      if (loaded) refused = await frame.evaluate(() => browser.tabs.query({}).then(() => "answered", (e) => e.message));
    }
    await new Promise((done) => setTimeout(done, 300));
  }
  check("F3 the relay refuses the extension page framed on a test site of the same tunnel", /relay answers only this extension's pages framed on/.test(refused), refused);

  writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, browser_specific_settings: { gecko: { id: "broken@foxkit" } } }));
  const broken = await launch({ extension }).then(() => "installed", (error) => error.message);
  check("R4 R5 a failed install throws without the key (the script exits, so the session closed)", broken !== "installed" && !broken.includes(process.env.ICHABOD_API_KEY), broken.slice(0, 200));
} catch (error) {
  record.error = error instanceof Error ? error.stack : String(error);
} finally {
  await fox?.close();
  await server?.close();
}
await closeTunnels();
check("T3 closeTunnels() stops the one cloudflared", tunnels() === before, { before, after: tunnels() });

// R11 and R4 read the written artifact, so it is written twice.
const first = readFileSync(writeArtifact("artifacts", "e2e-ichabod", record), "utf8");
const sessions = JSON.parse(first).ichabod ?? [];
check("R8 the artifact lists both Ichabod sessions with their IDs", sessions.length === 2 && sessions.every((s) => /^[0-9a-f-]{36}$/.test(s.sessionId)), sessions);
check("R4 the artifact does not hold the key", !first.includes(process.env.ICHABOD_API_KEY));
record.passed = !record.error && record.steps.every((s) => s.ok);
const path = writeArtifact("artifacts", "e2e-ichabod", record);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
