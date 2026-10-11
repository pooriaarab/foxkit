// Which browser a test runs in: the local Firefox or Ichabod, Mozilla's
// cloud browser service. docs/failure-modes.md R1.

export type BrowserMode = "ichabod" | "local";

/** The browser to use: the option, then FOXKIT_BROWSER, then local. Throws on any other value (R1). */
export function browserMode(explicit?: string): BrowserMode {
  const value = explicit ?? process.env.FOXKIT_BROWSER ?? "";
  if (value === "" || value === "local") return "local";
  if (value === "ichabod") return "ichabod";
  const source = explicit === undefined ? "FOXKIT_BROWSER" : "The remote option";
  throw new Error(`${source} is ${JSON.stringify(value)}. Use "ichabod" or "local".`);
}
