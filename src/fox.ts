// The fox mascot: fox/fox.svg and fox/fox.css, exported as create-foxkit/fox.svg
// and create-foxkit/fox.css. CSS moves it; no script runs. Put the SVG in an
// element and set data-state on that element to one of FOX_STATES.
// docs/failure-modes.md X1-X8 lists what must hold.

/** The states fox.css draws. `idle` is the default when data-state is unset. */
export const FOX_STATES = ["idle", "thinking", "working", "success", "error", "needs-approval"] as const;

export type FoxState = (typeof FOX_STATES)[number];
