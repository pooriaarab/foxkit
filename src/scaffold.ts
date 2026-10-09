// create-foxkit: copy template/ into a new directory, fill the placeholders,
// and run `git init -b main`. The failure modes it guards against are in
// docs/failure-modes.md (C1-C15). It checks all input and renders every file
// in memory before it writes one byte.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface Io {
  /** The directory the new repo goes into. */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface Options {
  name: string;
  prefix: string;
  description: string;
  package: string;
  owner: string;
  extension: boolean;
  /** The version spec of the create-foxkit dev dependency (--extension only). */
  foxkit: string;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE = join(ROOT, "template");
const MARKER = /foxkit:extension:(start|end)/;
// Images are copied byte for byte: the text pass would break them (C26).
const BINARY = /\.png$/;

const USAGE = `Usage: create-foxkit <name> --prefix <p> --description "<one sentence>" [options]

Creates the repo ./<name> from the foxkit template.

Options:
  --prefix <p>          PR and branch prefix, 2 to 5 lowercase letters (required)
  --description <text>  one sentence, at most 120 characters (required)
  --package <name>      npm package name (default: <name>)
  --owner <user>        GitHub owner of the repo (default: pooriaarab)
  --extension           add a test extension, the e2e script and an E2E CI job
  --foxkit <spec>       create-foxkit version for the e2e script (default: ^<this version>)
  -h, --help            show this help`;

const VALUE_FLAGS = new Set(["prefix", "description", "package", "owner", "foxkit"]);

class UsageError extends Error {}

function parse(argv: string[]): Partial<Options> & { help?: boolean } {
  const values: Record<string, string | boolean> = {};
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--extension") {
      values.extension = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      names.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`Unknown option ${arg}.`);
    const eq = arg.indexOf("=");
    const flag = arg.slice(2, eq === -1 ? undefined : eq);
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`Unknown option ${arg}.`);
    let value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || value.startsWith("--")) throw new UsageError(`Option --${flag} needs a value.`);
      i++;
    }
    values[flag] = value ?? "";
  }
  if (names.length !== 1) throw new UsageError(names.length ? `Give one name, not ${names.length}.` : "Give the repo name.");
  return { ...values, name: names[0] };
}

function validate(o: Partial<Options>): Options {
  const name = o.name ?? "";
  if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(name)) {
    throw new UsageError(`Name "${name}" is not valid. Use at most 60 lowercase letters, digits, ".", "_" and "-".`);
  }
  if (o.prefix === undefined) throw new UsageError("Give --prefix.");
  if (!/^[a-z]{2,5}$/.test(o.prefix)) throw new UsageError(`Prefix "${o.prefix}" is not valid. Use 2 to 5 lowercase letters.`);
  const description = (o.description ?? "").trim();
  if (o.description === undefined) throw new UsageError("Give --description.");
  if (!description) throw new UsageError("The description is empty.");
  if (/[\r\n]/.test(description)) throw new UsageError("The description must be one line.");
  if (description.length > 120) throw new UsageError(`The description has ${description.length} characters. The limit is 120.`);
  const pkg = o.package ?? name;
  if (pkg.length > 214 || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg)) {
    throw new UsageError(`Package name "${pkg}" is not a valid npm name.`);
  }
  const owner = o.owner ?? "pooriaarab";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new UsageError(`Owner "${owner}" is not a valid GitHub name.`);
  const extension = o.extension === true;
  // MDN: a gecko ID has at most 80 characters.
  if (extension && `${name}@${owner}`.length > 80) throw new UsageError(`The extension ID ${name}@${owner} is longer than 80 characters. Use a shorter name or owner.`);
  if (o.foxkit !== undefined && !extension) throw new UsageError("--foxkit has an effect only with --extension.");
  if (o.foxkit !== undefined && !o.foxkit.trim()) throw new UsageError("--foxkit is empty.");
  const own = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  return { name, prefix: o.prefix, description, package: pkg, owner, extension, foxkit: o.foxkit ?? `^${own.version}` };
}

function placeholders(o: Options): Record<string, string> {
  return {
    NAME: o.name,
    PACKAGE: o.package,
    PREFIX: o.prefix,
    PREFIX_UPPER: o.prefix.toUpperCase(),
    DESCRIPTION: o.description,
    OWNER: o.owner,
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    // Keys use "/" on every platform, so "_gitignore" matching works on Windows.
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .toSorted();
}

/** Keep or drop the lines between foxkit:extension:start and :end, and drop the marker lines. */
function blocks(text: string, rel: string, extension: boolean): string {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const marker = MARKER.exec(line)?.[1];
    if (marker === "start" && !inside) inside = true;
    else if (marker === "end" && inside) inside = false;
    else if (marker) throw new Error(`Template bug: unbalanced foxkit:extension:${marker} in ${rel}.`);
    else if (!inside || extension) out.push(line);
  }
  if (inside) throw new Error(`Template bug: foxkit:extension:start without an end in ${rel}.`);
  return out.join("\n");
}

/** Render one template directory into path -> content. Throws on an unknown placeholder. */
function render(dir: string, values: Record<string, string>, extension: boolean, files = new Map<string, string | Buffer>()): Map<string, string | Buffer> {
  for (const rel of walk(dir)) {
    if (BINARY.test(rel)) {
      files.set(rel, readFileSync(join(dir, rel)));
      continue;
    }
    const text = blocks(readFileSync(join(dir, rel), "utf8"), rel, extension);
    const json = rel.endsWith(".json");
    // One pass with a function: a value is never scanned again, and `$&` in a
    // value is not a replace pattern.
    const filled = text.replace(/__([A-Z][A-Z_]*)__/g, (_, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Template bug: unknown placeholder __${key}__ in ${rel}.`);
      return json ? JSON.stringify(value).slice(1, -1) : value;
    });
    const out = rel.split("/").map((part) => (part === "_gitignore" ? ".gitignore" : part)).join("/");
    files.set(out, filled);
  }
  return files;
}

function checkTarget(target: string): void {
  if (!existsSync(target)) return;
  if (!statSync(target).isDirectory()) throw new UsageError(`${target} exists and is not a directory.`);
  if (readdirSync(target).length > 0) throw new UsageError(`${target} is not empty. Choose a new name or empty it.`);
}

/** Run the command. Returns the exit code: 0 done, 1 failed, 2 bad input. */
export async function run(argv: string[], io: Io): Promise<number> {
  let options: Options;
  let target: string;
  let files: Map<string, string | Buffer>;
  try {
    const parsed = parse(argv);
    if (parsed.help) {
      io.out(USAGE);
      return 0;
    }
    options = validate(parsed);
    target = resolve(io.cwd, options.name);
    checkTarget(target);
    files = render(join(TEMPLATE, "base"), placeholders(options), options.extension);
    if (options.extension) {
      render(join(TEMPLATE, "extension"), placeholders(options), true, files);
      const pkg = JSON.parse(String(files.get("package.json") ?? "{}"));
      pkg.scripts["build:ext"] = "node scripts/build-ext.mjs";
      pkg.scripts["lint:ext"] = "web-ext lint -s dist-ext --warnings-as-errors";
      pkg.scripts["check:amo"] = "node scripts/amo-listing.mjs check";
      pkg.scripts["ci:local"] += " && pnpm build:ext && pnpm lint:ext && pnpm check:amo";
      pkg.scripts.e2e = "node scripts/build-ext.mjs --e2e && node e2e/run.mjs";
      Object.assign(pkg.devDependencies, { "create-foxkit": options.foxkit, esbuild: "^0.28.2", "web-ext": "^10.7.0" });
      files.set("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(error.message);
    io.err("");
    io.err(USAGE);
    return 2;
  }

  for (const [rel, content] of files) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), content);
  }
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: target, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    io.err(`Wrote ${files.size} files to ${target}, but "git init" failed: ${(error as Error).message}`);
    return 1;
  }

  io.out(`Created ${options.name} (${files.size} files) in ${target}.`);
  io.out("");
  io.out("Next steps:");
  io.out(`  cd ${relative(io.cwd, target) || "."}`);
  io.out("  pnpm install");
  io.out("  pnpm ci:local");
  if (options.extension) io.out("  pnpm e2e");
  io.out('  git add -A && git commit -m "Start the repo from foxkit"');
  return 0;
}
