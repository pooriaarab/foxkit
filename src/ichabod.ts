// Remote mode for create-foxkit/e2e: a Firefox on Ichabod, Mozilla's cloud
// browser service, instead of a local Firefox. docs/failure-modes.md R2-R8
// list what this file must not get wrong.
//
// Ichabod facts this file depends on (checked against Gecko 157):
// - The key goes in a Basic Authorization header (user "api"). It never goes
//   in a URL, because Puppeteer copies the endpoint URL into some errors.
// - Its Firefox runs without -remote-allow-system-access, so BiDi cannot
//   open, script or capture moz-extension: pages, and preferences cannot be
//   set. webExtension.install takes the extension only as base64 data.
// - The BiDi session.new result carries the session ID; nothing else does.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import puppeteer, { type Browser, type ConnectionTransport } from "puppeteer-core";

/** What writeArtifact() records about each remote session (R8). */
export interface RemoteSession {
  service: "ichabod";
  sessionId: string;
  firefox: string;
  recorded: boolean;
  startedAt: string;
}

/** Every remote session this process opened, for writeArtifact(). */
export const remoteSessions: RemoteSession[] = [];

const DEFAULT_HOST = "stage.api.ichabod.nonprod.webservices.mozgcp.net";
export const UUID_PAGE = "foxkit-uuid.html";
const UUID_SCRIPT = "foxkit-uuid.js";

/** Replace the Ichabod key, and its Basic header form, with *** (R4). */
export function redact(text: string): string {
  const key = process.env.ICHABOD_API_KEY;
  if (!key) return text;
  return text.replaceAll(key, "***").replaceAll(Buffer.from(`api:${key}`).toString("base64"), "***");
}

function redacted(error: unknown): Error {
  const out = new Error(redact(error instanceof Error ? error.message : String(error)));
  if (error instanceof Error && error.stack) out.stack = redact(error.stack);
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .toSorted();
}

/** A deflated zip of the given files. */
function zip(entries: Array<[string, Buffer]>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const fields = (header: Buffer, at: number) => {
      header.writeUInt16LE(0x0800, at); // UTF-8 names
      header.writeUInt16LE(8, at + 2); // deflate
      header.writeUInt32LE(0x00210000, at + 4); // 1980-01-01 00:00
      header.writeUInt32LE(crc32(data), at + 8);
      header.writeUInt32LE(packed.length, at + 12);
      header.writeUInt32LE(data.length, at + 16);
      header.writeUInt16LE(nameBytes.length, at + 20);
    };
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    fields(head, 6);
    const dirEntry = Buffer.alloc(46);
    dirEntry.writeUInt32LE(0x02014b50, 0);
    dirEntry.writeUInt16LE(20, 4);
    dirEntry.writeUInt16LE(20, 6);
    fields(dirEntry, 8);
    dirEntry.writeUInt32LE(offset, 42);
    local.push(head, nameBytes, packed);
    central.push(dirEntry, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/**
 * The extension as a zip, with one more background script that opens
 * foxkit-uuid.html once at install, so launch() can read the UUID (R6).
 * The directory does not change.
 */
export function remoteExtensionZip(dir: string): Buffer {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { background?: { scripts?: string[]; page?: string } };
  if (manifest.background?.page) throw new Error(`${join(dir, "manifest.json")} uses background.page. Remote mode adds a background script to find the extension UUID; use background.scripts.`);
  manifest.background = { ...manifest.background, scripts: [...(manifest.background?.scripts ?? []), UUID_SCRIPT] };
  const entries: Array<[string, Buffer]> = files(dir)
    .filter((name) => name !== "manifest.json")
    .map((name) => [name, readFileSync(join(dir, name))]);
  entries.push(
    ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
    [UUID_SCRIPT, Buffer.from(`// Added by create-foxkit/e2e in remote mode. The test reads the UUID from this tab, then closes it.\nbrowser.runtime.onInstalled.addListener(() => browser.tabs.create({ url: browser.runtime.getURL("${UUID_PAGE}"), active: false }));\n`)],
    [UUID_PAGE, Buffer.from('<!doctype html><meta charset="utf-8"><title>foxkit</title>\n')],
  );
  return zip(entries);
}

export interface RemoteOptions {
  extension: string;
  record?: boolean;
  firefox?: string;
  headless?: boolean;
  prefs?: Record<string, unknown>;
}

/** Connect to Ichabod, install the extension, and find its UUID. */
export async function connectIchabod(options: RemoteOptions): Promise<{ browser: Browser; base: string; close: () => Promise<void> }> {
  for (const [name, set] of [["prefs", options.prefs !== undefined], ["firefox", options.firefox !== undefined], ["headless", options.headless === false]] as const) {
    if (set) throw new Error(`Ichabod cannot apply the ${name} option: it runs its own headless Firefox and cannot set preferences. Remove the option, or run locally (FOXKIT_BROWSER=local).`);
  }
  const key = process.env.ICHABOD_API_KEY;
  if (!key) throw new Error("Remote mode needs ICHABOD_API_KEY. Set it to an Ichabod project API key.");
  const record = options.record ?? true;
  const endpoint = `wss://${process.env.ICHABOD_HOST ?? DEFAULT_HOST}/gecko/${process.env.ICHABOD_GECKO ?? "latest"}${record ? "" : "?record_session=false"}`;
  const zipped = remoteExtensionZip(options.extension);

  let browser: Browser | undefined;
  let ws: WebSocket | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await browser?.close().catch(() => {});
      ws?.close();
    })());
  try {
    let sessionId = "";
    ws = new WebSocket(endpoint, { headers: { authorization: `Basic ${Buffer.from(`api:${key}`).toString("base64")}` } } as unknown as string[]);
    const socket = ws;
    await new Promise<void>((done, fail) => {
      socket.addEventListener("open", () => done());
      socket.addEventListener("error", (event) => fail(new Error(`Cannot connect to Ichabod at ${endpoint}: ${(event as ErrorEvent).message || "the connection failed"}.`)));
    });
    const transport: ConnectionTransport = { send: (message) => socket.send(message), close: () => socket.close() };
    socket.addEventListener("message", (event) => {
      const message = String(event.data);
      if (!sessionId && message.includes('"sessionId"')) sessionId = (JSON.parse(message) as { result?: { sessionId?: string } }).result?.sessionId ?? "";
      transport.onmessage?.(message);
    });
    socket.addEventListener("close", () => transport.onclose?.());
    browser = await puppeteer.connect({ transport, protocol: "webDriverBiDi", defaultViewport: null });
    remoteSessions.push({ service: "ichabod", sessionId, firefox: await browser.version(), recorded: record, startedAt: new Date().toISOString() });
    // Puppeteer types connection for CDP only; on BiDi it sends raw BiDi commands.
    const bidi = (browser as unknown as { connection: { send(method: string, params: object): Promise<{ result: unknown }> } }).connection;
    const send = (method: string, params: object) => bidi.send(method, params);
    await send("webExtension.install", { extensionData: { type: "base64", value: zipped.toString("base64") } });

    const deadline = Date.now() + 15_000;
    for (;;) {
      const { result } = await send("browsingContext.getTree", { maxDepth: 0 });
      const tab = (result as { contexts: Array<{ context: string; url: string }> }).contexts.find((c) => c.url.endsWith(`/${UUID_PAGE}`));
      const uuid = tab && /^moz-extension:\/\/([0-9a-f-]{36})\//.exec(tab.url)?.[1];
      if (tab && uuid) {
        await send("browsingContext.close", { context: tab.context });
        return { browser, base: `moz-extension://${uuid}/`, close };
      }
      if (Date.now() > deadline) throw new Error(`The extension did not open ${UUID_PAGE} within 15 s, so its moz-extension: UUID is unknown.`);
      await new Promise((done) => setTimeout(done, 200));
    }
  } catch (error) {
    await close();
    throw redacted(error);
  }
}
