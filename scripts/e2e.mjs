// The main E2E test for foxkit. It runs the built create-foxkit the way a
// user does and writes artifacts/e2e-<date>.json with every step and result.
//
//   1. Scaffold a plain repo, then pnpm install and pnpm ci:local in it.
//   2. Scaffold a repo with --extension, then pnpm install, pnpm ci:local (it
//      builds dist-ext/ and runs web-ext lint) and pnpm e2e in it. pnpm e2e
//      starts a real Firefox with the demo extension. A manifest version that
//      differs from package.json must stop build:ext (C23).
//   3. Drive dist-ext/ through dist/e2e.js directly, and check that close()
//      deletes the profile and that a second close() does nothing (H6).
//   4. Run create-foxkit on a directory that is not empty; it must exit 2.
//
// Usage: pnpm e2e (it builds first). Env: FIREFOX (the Firefox binary).
// Firefox cannot start inside a sandbox that blocks it.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, poll, writeArtifact } from "../dist/e2e.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const work = mkdtempSync(join(tmpdir(), "foxkit-e2e-"));
const record = { startedAt: new Date().toISOString(), node: process.version, steps: [] };

function step(name, command, args, cwd, expectedExit = 0) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  const exitCode = result.status ?? -1;
  const ok = exitCode === expectedExit;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  record.steps.push({ name, command: [command, ...args].join(" ").replaceAll(root, "<foxkit>/").replaceAll(work, "<tmp>"), cwd: relative(work, cwd) || ".", exitCode, expectedExit, ok, ms: Date.now() - started, ...(ok ? {} : { outputTail: output.slice(-2000) }) });
  console.log(`${ok ? "ok " : "BAD"} ${name} (exit ${exitCode}, ${Date.now() - started} ms)`);
  if (!ok) console.log(output.slice(-2000));
  return { ok, output };
}

function check(name, ok, detail) {
  record.steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "ok " : "BAD"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

function leftovers(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !/[/\\](node_modules|\.git|dist)([/\\]|$)/.test(e.parentPath))
    .map((e) => join(e.parentPath, e.name))
    .filter((file) => /__[A-Z][A-Z_]*__|foxkit:extension/.test(readFileSync(file, "utf8")))
    .map((file) => relative(dir, file));
}

try {
  record.pnpm = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  record.gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  // 1. A plain repo.
  const plain = join(work, "plain-demo");
  step("scaffold a plain repo", "node", [cli, "plain-demo", "--prefix", "pln", "--description", "A plain demo repo."], work);
  check("plain repo has no placeholder or marker", leftovers(plain).length === 0, leftovers(plain));
  check("plain repo has no extension fixture", !existsSync(join(plain, "extension")));
  step("pnpm install (plain)", "pnpm", ["install", "--no-frozen-lockfile"], plain);
  step("pnpm ci:local (plain)", "pnpm", ["ci:local"], plain);

  // 2. A repo with --extension, using this checkout as create-foxkit.
  const ext = join(work, "ext-demo");
  step("scaffold a repo with --extension", "node", [cli, "ext-demo", "--prefix", "ext", "--description", "An extension demo repo.", "--extension", "--foxkit", `file:${root}`], work);
  check("extension repo has no placeholder or marker", leftovers(ext).length === 0, leftovers(ext));
  step("pnpm install (extension)", "pnpm", ["install", "--no-frozen-lockfile"], ext);
  const ciLocal = step("pnpm ci:local (extension, with build:ext and web-ext lint)", "pnpm", ["ci:local"], ext);
  check("web-ext lint reports 0 errors and 0 warnings", /errors\s+0\b[\s\S]*warnings\s+0\b/.test(ciLocal.output));
  step("pnpm e2e (extension, real Firefox)", "pnpm", ["e2e"], ext);
  const artifacts = existsSync(join(ext, "artifacts")) ? readdirSync(join(ext, "artifacts")) : [];
  const inner = artifacts.length ? JSON.parse(readFileSync(join(ext, "artifacts", artifacts[0]), "utf8")) : null;
  record.extensionRepoArtifact = inner;
  check("extension repo artifact says passed", inner?.passed === true, inner?.checks?.map((c) => `${c.name}: ${c.actual}`));

  const pkgFile = join(ext, "package.json");
  const pkgText = readFileSync(pkgFile, "utf8");
  writeFileSync(pkgFile, pkgText.replace('"version": "0.1.0"', '"version": "0.2.0"'));
  const mismatch = step("build:ext refuses a manifest version that differs from package.json", "pnpm", ["build:ext"], ext, 1);
  check("the refusal names both versions", mismatch.output.includes("0.1.0") && mismatch.output.includes("0.2.0"));
  writeFileSync(pkgFile, pkgText);

  // 3. The harness from this build, against the generated fixture.
  const fox = await launch({ extension: join(ext, "dist-ext") });
  try {
    record.firefox = await fox.browser.version();
    const page = await fox.openExtensionPage("popup.html");
    const value = await poll(page, () => document.getElementById("value")?.textContent);
    check("harness reads the demo extension's popup page", value === "installed", value);
  } finally {
    await fox.close();
    await fox.close();
  }
  check("close() deleted the profile, and a second close() did not throw", !existsSync(fox.profile), basename(fox.profile));

  // 4. Refuse to write into a directory that is not empty.
  step("refuse a directory that is not empty", "node", [cli, "plain-demo", "--prefix", "pln", "--description", "Again."], work, 2);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  console.log(`BAD ${record.error}`);
}

record.passed = !record.error && record.steps.every((s) => s.ok);
record.finishedAt = new Date().toISOString();
const path = writeArtifact(join(root, "artifacts"), "e2e", record);
rmSync(work, { recursive: true, force: true });
console.log(`${record.passed ? "PASS" : "FAIL"} | ${relative(root, path)}`);
process.exitCode = record.passed ? 0 : 1;
