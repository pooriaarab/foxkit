// Tests for the fox mascot: X1-X8 in docs/failure-modes.md. They read the
// files that ship (fox/fox.svg, fox/fox.css). Screenshots of each state, in
// light, dark and reduced motion, show what the tests cannot.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FOX_STATES } from "../src/fox.js";

const svg = readFileSync(new URL("../fox/fox.svg", import.meta.url), "utf8");
const css = readFileSync(new URL("../fox/fox.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits off the blocks of one at-rule (`@keyframes`, `@media ...`), with their bodies. */
function atRules(text: string, name: string) {
  const found: { prelude: string; body: string }[] = [];
  let rest = text;
  for (let at = rest.indexOf(`@${name}`); at >= 0; at = rest.indexOf(`@${name}`)) {
    const open = rest.indexOf("{", at);
    let depth = 1;
    let i = open + 1;
    for (; depth > 0 && i < rest.length; i++) depth += rest[i] === "{" ? 1 : rest[i] === "}" ? -1 : 0;
    found.push({ prelude: rest.slice(at, open).trim(), body: rest.slice(open + 1, i - 1) });
    rest = rest.slice(0, at) + rest.slice(i);
  }
  return { found, rest };
}

const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
const keyframes = atRules(css, "keyframes");
const media = atRules(keyframes.rest, "media");
const plain = rules(media.rest);
// The variables that a still property (not an animation) reads: the poses.
const poseVars = new Set(plain.flatMap((r) => [...r.body.matchAll(/(?:^|;)\s*(?:translate|rotate|display)\s*:\s*var\((--[\w-]+)/g)].map((m) => m[1]!)));

describe("fox mascot", () => {
  it("X1 stays under 3 KB of SVG and CSS", () => {
    const bytes = Buffer.byteLength(svg) + Buffer.byteLength(readFileSync(new URL("../fox/fox.css", import.meta.url)));
    expect(bytes).toBeLessThan(3072);
  });

  it("X2 animates and transitions only transform and opacity", () => {
    for (const k of keyframes.found) {
      for (const r of rules(k.body)) {
        for (const prop of r.body.split(";").map((d) => d.split(":")[0]!.trim()).filter(Boolean)) {
          expect(["transform", "opacity"], `${k.prelude} ${r.selector} moves ${prop}`).toContain(prop);
        }
      }
    }
    expect(css).not.toMatch(/transition(-property)?\s*:(?![^;]*\b(transform|opacity)\b)/);
    expect(css).toMatch(/overflow\s*:\s*visible/);
  });

  it("X3 stops every animation for reduced motion", () => {
    const reduce = media.found.find((m) => /prefers-reduced-motion:\s*reduce/.test(m.prelude));
    expect(reduce, "no prefers-reduced-motion: reduce block").toBeDefined();
    expect(rules(reduce!.body).some((r) => /\.fox-mascot \*/.test(r.selector) && /animation\s*:\s*none\s*!important/.test(r.body))).toBe(true);
  });

  it("X4 and X5 give every state but idle a still pose outside the keyframes", () => {
    expect(FOX_STATES).toEqual(["idle", "thinking", "working", "success", "error", "needs-approval"]);
    for (const state of FOX_STATES.filter((s) => s !== "idle")) {
      const own = plain.filter((r) => new RegExp(`\\[data-state="?${state}"?\\]`).test(r.selector));
      expect(own.length, `no rule for ${state}`).toBeGreaterThan(0);
      const sets = own.flatMap((r) => [...r.body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
      expect(sets.some((v) => poseVars.has(v)), `${state} has no still pose`).toBe(true);
    }
  });

  it("X6 hides the drawing from screen readers and from focus", () => {
    const tag = svg.match(/<svg\b[^>]*>/)?.[0] ?? "";
    expect(tag).toMatch(/class="fox-mascot"/);
    expect(tag).toMatch(/aria-hidden="true"/);
    expect(tag).toMatch(/focusable="false"/);
    expect(svg).not.toMatch(/<(script|image|foreignObject|title)\b/);
  });

  it("X8 draws no outline when the page strokes its icons", () => {
    expect(plain.find((r) => r.selector === ".fox-mascot")?.body).toMatch(/(^|;)stroke:none(;|$)/);
  });

  it("X7 keeps the fur and the eyes at 3:1 or more in both themes", () => {
    const light = media.found.find((m) => /prefers-color-scheme:\s*light/.test(m.prelude));
    expect(light, "no light theme block").toBeDefined();
    const dark = vars(plain.find((r) => r.selector === ".fox-mascot")?.body ?? "");
    const themes = {
      // The page, panel and raised colors of the fox look (foxmate app.css).
      dark: { fox: dark, pages: ["oklch(0.155 0.004 60)", "oklch(0.195 0.005 60)", "oklch(0.225 0.006 60)"] },
      light: { fox: { ...dark, ...vars(light!.body) }, pages: ["oklch(0.985 0.003 80)", "oklch(1 0 0)", "oklch(0.955 0.005 80)"] },
    };
    for (const [name, t] of Object.entries(themes)) {
      for (const page of t.pages) expect(contrast(t.fox.fur!, page), `${name} fur on ${page}`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.fox.ink!, t.fox.fur!), `${name} eyes on fur`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.fox.ink!, t.fox.cream!), `${name} eyes on cream`).toBeGreaterThanOrEqual(3);
    }
  });
});

/** The --fox-* colors a rule body sets. */
const vars = (body: string) => Object.fromEntries([...body.matchAll(/--fox-(\w+)\s*:\s*(oklch\([^)]*\))/g)].map((m) => [m[1]!, m[2]!]));
const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** WCAG contrast ratio of two oklch() colors. */
function contrast(a: string, b: string) {
  const [la, lb] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (la + 0.05) / (lb + 0.05);
}

/** Relative luminance of an oklch() color, through linear sRGB. */
function luminance(color: string) {
  const [L, C, H] = color.slice(6, -1).trim().split(/\s+/).map(Number) as [number, number, number];
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
