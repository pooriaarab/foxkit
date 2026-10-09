// Tests for the failure modes C1-C15 in docs/failure-modes.md. They drive the
// command through its argument list, the same way the bin does.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/scaffold.js";

let cwd = "";
let out: string[] = [];
let err: string[] = [];
const cli = (...argv: string[]) => run(argv, { cwd, out: (s) => out.push(s), err: (s) => err.push(s) });
const ok = ["demo", "--prefix", "dmo", "--description", "A demo fox repo."];

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !join(e.parentPath, e.name).includes(`${dir}/.git/`))
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "foxkit-test-"));
  out = [];
  err = [];
});

describe("refuses bad input and writes nothing", () => {
  const cases: [string, string[]][] = [
    ["C1 no name", ["--prefix", "dmo", "--description", "x"]],
    ["C1 two names", ["demo", "other", "--prefix", "dmo", "--description", "x"]],
    ["C2 uppercase name", ["Demo", "--prefix", "dmo", "--description", "x"]],
    ["C2 name with a space", ["my demo", "--prefix", "dmo", "--description", "x"]],
    ["C2 name with a slash", ["a/b", "--prefix", "dmo", "--description", "x"]],
    ["C2 dot-dot name", ["..", "--prefix", "dmo", "--description", "x"]],
    ["C3 no prefix", ["demo", "--description", "x"]],
    ["C3 prefix too long", ["demo", "--prefix", "abcdef", "--description", "x"]],
    ["C3 prefix with a digit", ["demo", "--prefix", "ab1", "--description", "x"]],
    ["C3 uppercase prefix", ["demo", "--prefix", "DMO", "--description", "x"]],
    ["C4 no description", ["demo", "--prefix", "dmo"]],
    ["C4 empty description", ["demo", "--prefix", "dmo", "--description", "  "]],
    ["C4 two-line description", ["demo", "--prefix", "dmo", "--description", "a\nb"]],
    ["C4 long description", ["demo", "--prefix", "dmo", "--description", "x".repeat(121)]],
    ["C5 bad package name", [...ok, "--package", "Bad Name"]],
    ["C5 package name with a leading dot", [...ok, "--package", ".hidden"]],
    ["C6 unknown flag", [...ok, "--extention"]],
    ["C7 flag at the end with no value", ["demo", "--description", "x", "--prefix"]],
    ["C7 flag followed by a flag", ["demo", "--prefix", "--description", "x"]],
  ];
  for (const [name, argv] of cases) {
    it(name, async () => {
      expect(await cli(...argv)).toBe(2);
      expect(err.join("\n")).not.toBe("");
      expect(readdirSync(cwd)).toEqual([]);
    });
  }
});

describe("the target path", () => {
  it("C8 refuses a directory with files and leaves them alone", async () => {
    mkdirSync(join(cwd, "demo"));
    writeFileSync(join(cwd, "demo", "keep.txt"), "mine");
    expect(await cli(...ok)).toBe(2);
    expect(readdirSync(join(cwd, "demo"))).toEqual(["keep.txt"]);
    expect(readFileSync(join(cwd, "demo", "keep.txt"), "utf8")).toBe("mine");
  });

  it("C9 refuses a path that is a file", async () => {
    writeFileSync(join(cwd, "demo"), "mine");
    expect(await cli(...ok)).toBe(2);
    expect(readFileSync(join(cwd, "demo"), "utf8")).toBe("mine");
  });

  it("C10 uses an empty directory", async () => {
    mkdirSync(join(cwd, "demo"));
    expect(await cli(...ok)).toBe(0);
    expect(statSync(join(cwd, "demo", "package.json")).isFile()).toBe(true);
  });
});

describe("a generated repo", () => {
  it("C11 keeps a description with JSON and replace specials exact", async () => {
    const description = 'Say "hi" with a \\ and $& and $1 in it.';
    expect(await cli("demo", "--prefix", "dmo", "--description", description)).toBe(0);
    const pkg = JSON.parse(readFileSync(join(cwd, "demo", "package.json"), "utf8"));
    expect(pkg.description).toBe(description);
  });

  it("C12 holds no placeholder in any file", async () => {
    expect(await cli(...ok, "--package", "@me/demo")).toBe(0);
    const dir = join(cwd, "demo");
    for (const file of files(dir)) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/__[A-Z][A-Z_]*__/);
    }
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("@me/demo");
    const standards = JSON.parse(readFileSync(join(dir, ".github", "pr-standards.json"), "utf8"));
    expect(standards.prefix).toBe("dmo");
  });

  it("C13 writes .gitignore, not _gitignore", async () => {
    expect(await cli(...ok)).toBe(0);
    const list = files(join(cwd, "demo"));
    expect(list).toContain(".gitignore");
    expect(list).not.toContain("_gitignore");
  });

  it("C14 is a Git repository on main", async () => {
    expect(await cli(...ok)).toBe(0);
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: join(cwd, "demo"), encoding: "utf8" });
    expect(branch.trim()).toBe("main");
  });

  it("C15 prints the next steps", async () => {
    expect(await cli(...ok)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("cd demo");
    expect(text).toContain("pnpm install");
    expect(text).toContain("pnpm ci:local");
  });

  it("prints the usage for --help and writes nothing", async () => {
    expect(await cli("--help")).toBe(0);
    expect(out.join("\n")).toContain("--prefix");
    expect(readdirSync(cwd)).toEqual([]);
  });
});
