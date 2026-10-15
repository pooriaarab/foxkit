# foxkit

[![npm version](https://img.shields.io/npm/v/create-foxkit)](https://www.npmjs.com/package/create-foxkit)
[![Downloads per month](https://img.shields.io/npm/dm/create-foxkit)](https://www.npmjs.com/package/create-foxkit)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/create-foxkit) · [Setup](#create-your-first-repo) · [API](#api) · [Issues](https://github.com/pooriaarab/foxkit/issues)

foxkit is an open-source TypeScript project generator and Firefox extension test harness for package maintainers.
The `create-foxkit` command creates repositories with GitHub Actions, pnpm checks, and npm release workflows.
Its library drives Firefox through Puppeteer and includes local and Ichabod browser modes.

## Install

```bash
npm install --save-dev create-foxkit
```

Use Node.js 24 or later. The package has one direct runtime dependency, `puppeteer-core`.
Scaffolding also needs Git; generated repositories use pnpm 11.10.0.

## Create your first repo

Run this command in a directory without an existing `foxdemo` project:

```bash
npm create foxkit@latest foxdemo -- --prefix fdm --description "A Firefox extension." --extension
cd foxdemo
pnpm install
pnpm ci:local
pnpm e2e
```

The generator prints `Created foxdemo` and initializes a `main` branch.
The browser test writes `artifacts/e2e-<date>.json` after its assertions pass.
Install Firefox first; set `FIREFOX` to its binary path when automatic lookup fails.
Local mode needs no credentials. Environment variables come from your shell; the library does not load `.env` files.
The generated extension is a starting example. Replace its behavior and AMO listing before release.

## How it works

```text
CLI arguments -> validated template -> new Git repository
Test -> create-foxkit/e2e -> Puppeteer -> local Firefox or Ichabod
Remote pages -> shared Cloudflare quick tunnel -> Ichabod Firefox
```

Input validation and template rendering finish before the generator writes files.
Local tests use temporary Firefox profiles and temporary add-ons.
Remote mode changes the installed extension copy to support framed extension pages.

## Why it exists

foxkit puts a fixed TypeScript package workflow and Firefox extension tests in one template.
[Yeoman](https://yeoman.io/) provides a generator ecosystem when you need a different project structure.
foxkit supplies one opinionated template with an optional extension overlay.

## Compare

Checked 2026-10-14 against the source and [Yeoman documentation](https://yeoman.io/).

| Property | foxkit | Yeoman |
|---|---|---|
| Scope | TypeScript package and optional Firefox extension | Generator ecosystem |
| Configuration | CLI flags and bundled template | Selected generator |
| Execution | Local Node.js CLI | Local `yo` CLI |
| Browser harness | Included Firefox library | Depends on generator |
| License | MIT | BSD-2-Clause for `yo` |

## Coverage

| Integration | Status | Source behavior |
|---|---|---|
| Mozilla Firefox | Implemented | Temporary extension installation through WebDriver BiDi |
| Puppeteer | Implemented | Browser connection, pages, and evaluation |
| Mozilla Ichabod | Implemented | Remote Firefox sessions with project credentials |
| Cloudflare quick tunnels | Implemented | Shared public HTTP tunnel through `cloudflared` |
| GitHub Actions | Template | CI, PR checks, and release workflows |
| npm | Template | Publish workflow with provenance |
| Mozilla Add-ons (AMO) | Template; live submission unverified | Extension listing checks and release submission steps |

The table has seven integration entries. These statuses describe code paths, not live service certification.
No credentialed Ichabod or AMO run is claimed by this README rewrite.
The mascot exports six states: `idle`, `thinking`, `working`, `success`, `error`, and `needs-approval`.

## Common use cases

1. Firefox extension authors: generate a Manifest V3 starter with pnpm checks and GitHub Actions.
2. TypeScript maintainers: create an npm library with a release branch workflow.
3. Existing Firefox projects: add Puppeteer tests with `create-foxkit/e2e`.
4. Browser test authors: serve fixture pages and write JSON artifacts on Node.js.
5. Ichabod users: run extension checks remotely through a shared Cloudflare tunnel.

## Features

- **Generator:** validates names, prefixes, descriptions, package names, and target directories before writing.
- **Extension overlay:** includes esbuild, web-ext checks, an AMO listing, and browser tests.
- **Browser harness:** exposes launch, navigation, polling, fixture serving, and artifact helpers.
- **Remote mode:** uses Ichabod credentials and a shared Cloudflare quick tunnel.
- **Mascot:** provides an SVG, CSS, and six typed state names.

## Runtime surfaces

The CLI runs on Node.js 24 or later. The test library controls Firefox only.
foxkit has no Model Context Protocol (MCP) server or MCP tools.

### CLI

```text
create-foxkit <name> --prefix <p> --description "<one sentence>" [options]
```

| Option | Meaning |
|---|---|
| `<name>` | The directory and repo name. At most 60 lowercase letters, digits, `.`, `_` and `-`. |
| `--prefix <p>` | The PR and branch prefix, 2 to 5 lowercase letters. Required. |
| `--description <text>` | One sentence, at most 120 characters. Required. |
| `--package <name>` | The npm package name. The default is `<name>`. |
| `--owner <user>` | The GitHub owner. The default is `pooriaarab`. |
| `--extension` | Add the test extension, the `e2e` script and the E2E CI job. |
| `--foxkit <spec>` | The `create-foxkit` version for the `e2e` script. The default is `^<version of this create-foxkit>`. Use it with `--extension` only. |
| `-h`, `--help` | Show the help. |

The command exits 0 when it is done, 1 when `git init` fails, and 2 for bad
input. It refuses a target directory that is not empty. It has no prompts.

Template files use these placeholders: `__NAME__`, `__PACKAGE__`,
`__PREFIX__`, `__PREFIX_UPPER__`, `__DESCRIPTION__` and `__OWNER__`. In
`.json` files, the command escapes the values for JSON.

### API

The E2E exports come from `create-foxkit/e2e`. The fox mascot is in
`create-foxkit/fox`; see "The fox mascot".

| Export | What it does |
|---|---|
| `launch(options)` | Starts Firefox with a new profile and installs the extension as a temporary add-on. Returns a `Fox`. |
| `poll(page, fn, arg?, timeoutMs = 30000)` | Runs `fn(arg)` in the page until it returns a truthy value, and returns that value. Throws after the timeout. |
| `serve(dir, { tunnel? })` | Serves a directory on `http://127.0.0.1:<free port>`. Returns `{ url, close }`. Paths outside the directory get 404. In remote mode, `url` is a public URL on the shared tunnel. |
| `tunnel(port, { cloudflared?, timeoutMs?, signal?, root? })` | Mounts `http://127.0.0.1:<port>` on the shared quick tunnel. Returns `{ url, close }`; `url` is `https://<random>.trycloudflare.com/_foxkit/<id>`. With `root: true`, the server sits at the root of the tunnel and `url` is the tunnel origin, so a single-page app sees its own paths; one root mount at a time, and the other mounts still win the requests they claim. |
| `closeTunnels()` | Stops the shared tunnel now, instead of at process exit. |
| `writeArtifact(dir, name, data)` | Writes `data` as JSON to `<dir>/<name>-<YYYY-MM-DD>.json` (UTC date) and returns the path. After a remote run, it adds the Ichabod sessions. It replaces `ICHABOD_API_KEY` with `***`. |
| `findFirefox(path?)` | Returns the Firefox binary: `path`, then `FIREFOX`, then the usual install paths. Throws when there is none. |

`launch(options)` takes these options:

| Option | Meaning |
|---|---|
| `extension` | The extension directory. Its `manifest.json` must set `browser_specific_settings.gecko.id`. Required. |
| `firefox` | The Firefox binary. See `findFirefox`. |
| `headless` | Run with no window. The default is `true`. |
| `prefs` | More Firefox preferences. Remote mode refuses it. |
| `remote` | `"ichabod"` or `"local"`. The default is `FOXKIT_BROWSER`, then `"local"`. |
| `record` | Remote mode only. Record the session to video. The default is `true`. |

A `Fox` has these members:

| Member | What it does |
|---|---|
| `browser` | The Puppeteer `Browser`, for anything else. |
| `profile` | The temporary profile directory. |
| `extensionId` | The gecko ID from the manifest. |
| `extensionUrl(path?)` | Returns `moz-extension://<uuid>/<path>`. |
| `open(url)` | Opens the URL in a new tab, waits for the load event, and returns the Puppeteer `Page`. On Ichabod the limit is 60 s, not 30 s, and a timeout or network error gets one more try with a log line. The page keeps 60 s as its default navigation timeout. |
| `openExtensionPage(path, timeoutMs = 30000)` | Opens an extension page in a new tab and polls until it is loaded. In remote mode the page is in a frame: see "Extension pages on Ichabod". |
| `close()` | Stops Firefox and deletes the profile. A second call does nothing. |

#### Remote mode (Ichabod)

Set `FOXKIT_BROWSER=ichabod` and `ICHABOD_API_KEY` to run a test on a Firefox
on Ichabod, Mozilla's cloud browser service, instead of this computer. The
test code does not change:

- `launch()` connects over WebDriver BiDi and installs the extension as
  base64 data. It sends the key in a header, never in a URL.
- `serve()` gives the pages a public URL, so the cloud browser can load
  them. It needs `cloudflared` (`brew install cloudflared`).
- `writeArtifact()` records the BiDi session ID, so a PR can point to the
  recording on the Ichabod console.

`FOXKIT_BROWSER` accepts `ichabod` and `local` only. Any other value stops the
test, so a typo never runs it on the local Firefox. `ICHABOD_HOST` and
`ICHABOD_GECKO` (default `latest`) choose the service host and the Gecko
version.

Ichabod's Firefox runs without `-remote-allow-system-access`, so remote mode
has limits:

- `prefs`, `firefox` and `headless: false` throw: Ichabod cannot set them.
- A server that a test starts itself on `127.0.0.1` is not reachable. Give
  it a public URL with `tunnel(port)`. A content script or host permission
  that matches only `127.0.0.1` does not match the tunnel host.
- To find the extension UUID, the installed copy gets one more background
  script. It opens `foxkit-uuid.html` once, in a background tab, and
  `launch()` closes that tab.
- A page that the extension opens in a tab itself (`tabs.create`) is not
  reachable. Open it with `openExtensionPage()` instead.

##### Extension pages on Ichabod

BiDi cannot script or capture a `moz-extension:` page in a tab there, but it
can when the page is in an iframe on an https page. So `openExtensionPage()`
opens a frame host page (a local page that `launch()` mounts on the shared
tunnel) and loads the extension page in an iframe that fills the tab. It returns a
`Page`: `evaluate`, `$`, `click`, `type`, `waitForSelector` and the other DOM
calls go to the frame; `screenshot`, `bringToFront`, `close`, `keyboard` and
`mouse` go to the tab. `url()` returns the extension URL it opened.

A framed extension page gets the real `runtime`, `storage` and `i18n`, and
the real page code, origin and CSP. Firefox gives it no other namespaces.
The installed copy fills those that the manifest grants with a relay to the
background page:

| Namespace | In a framed page |
|---|---|
| `runtime`, `storage`, `i18n` | Real, except `storage.session`. |
| `storage.session` | Relayed when `permissions` lists `storage`: calls, `onChanged` and `QUOTA_BYTES`. |
| `tabs`, `windows`, `permissions` | Relayed: calls and `on*` events. |
| `action`, `sidebarAction`, `browserAction`, `pageAction` | Relayed when the manifest has the key. |
| `alarms`, `bookmarks`, `browsingData`, `contextualIdentities`, `cookies`, `downloads`, `history`, `notifications`, `scripting`, `sessions`, `topSites`, `webNavigation` | Relayed when `permissions` lists them. |
| Any other granted namespace (`webRequest`, `proxy`, `privacy` ...) | Throws on access, and names the namespace. |
| `extension.getViews()` | `[]` for `{ type: "sidebar" }` and `{ type: "popup" }`; throws for any other filter. |

- A relayed call runs in the background page. A call that needs a user
  gesture, such as `permissions.request()` or `sidebarAction.open()`, fails,
  and the error says so.
- `tabs.getCurrent()`, `windows.getCurrent()` and `currentWindow: true`
  answer for the frame's tab. In relayed results and events, that tab has
  the extension page URL, as it would for a user. The background page's own
  `tabs` calls still see the frame host URL.
- Arguments and results must be cloneable. A relayed call that gets a
  function, a symbol or a DOM node rejects before it is sent, and the error
  names the API and the argument, for example
  `browser.scripting.executeScript: args[0].func is a function`. The
  background page cannot rebuild a function: Manifest V3 blocks `eval`
  there. Pass `files` to `scripting.executeScript`, or run that check
  locally. `typeof browser.tabs.anyName` is `"function"`; the call rejects
  when the member does not exist.
- The relay covers `browser.*`, not `chrome.*`.
- The extension pages are web accessible to the tunnel origin. Firefox
  matches that by origin only, so a test site on the tunnel can frame a
  page, but the relay answers only this extension's pages framed in a tab
  on the frame host path. It uses a port
  named `foxkit-relay`: an extension whose `runtime.onConnect` listener does
  not check `port.name` sees it.
- Remote mode needs Manifest V3: only V3 can limit web accessible pages to
  one origin.

A process opens one Cloudflare quick tunnel, whatever the number of
servers: Cloudflare refuses quick tunnels with HTTP 429 after about 15 in a
short time. The tunnel points at a local gateway, and `serve()`, `tunnel()`
and the frame host each mount at `/_foxkit/<id>/`:

- The gateway strips the prefix before it forwards. A request for an
  absolute path such as `/app.js` goes to the mount that its `Referer`
  names, and a redirect to `/path` gets the prefix back. When that request
  is a page navigation (a link or a form), the gateway answers `307` to the
  same path under the mount, so the next page keeps the prefix for its own
  links.
- `tunnel(port, { root: true })` mounts one server at the root instead, for
  a site that routes on its full path (a single-page app) or whose address
  is typed with an absolute path. Requests that no other mount claims go to
  it as they are.
- All mounts share one origin. A check that needs two sites on different
  origins, or a host name such as `bank.localhost`, must run locally.
- WebSocket upgrades are not forwarded.
- `close()` unmounts at once. The tunnel does not keep the process alive,
  and it stops at process exit or at `closeTunnels()`.

> **Warning:** a mounted server is public at a random URL until
> `close()`. Anyone with the URL reaches it. For a model server, start it
> with its own key, for example `llama-server --api-key <key>`, and send
> that key from the test.

A function that you give to `poll()` or `page.evaluate()` runs in the page,
not in Node. It cannot use variables from outside it. Pass values through
`arg`.

#### The fox mascot

One animated fox for every fox* extension. It is an inline SVG that CSS moves;
no script runs. The SVG and the CSS together are under 3 KB.

| Export | What it is |
|---|---|
| `create-foxkit/fox.svg` | The drawing. Put it inline in the page, for example in a `<template>`. An `<img>` cannot animate it. |
| `create-foxkit/fox.css` | The colors, the poses and the motion. |
| `FOX_STATES` and `FoxState` from `create-foxkit/fox` | The states the CSS draws. |

Put the SVG in an element, and set `data-state` on that element. Only the SVG's
own parent sets its state, so a `data-state` further up does not reach it. The
SVG fills the element, so the element sets the size. Make the element a block
or an inline-block: an inline `<span>` ignores `width` and `height`, and the fox
then takes the full width of the block around it.

```html
<span class="mascot" data-state="working" style="display: inline-block; width: 96px; height: 96px"><!-- fox.svg --></span>
<span role="status">Working on example.com</span>
```

| `data-state` | What the fox does |
|---|---|
| `idle` (or no attribute) | Breathes, sways its tail, blinks, and twitches one ear every few seconds. |
| `thinking` | Looks up and tilts its head, with slow nods. |
| `working` | Reads: looks down and from side to side, with quick nods. |
| `success` | Happy eyes and one hop. Set it back to `idle` after a few seconds. |
| `error` | Ears out, head down, tail low, one small shake. |
| `needs-approval` | Tilts its head, ears up, and looks down to the right, at the approval. |

- The SVG has `aria-hidden="true"`. Put the status in text next to it.
- Every part of the fox sets `stroke: none`, so a page rule that strokes its
  icons (`svg { stroke: currentColor }`) does not outline the fox.
- Only `transform` moves. The fox never changes its box, so nothing next to it
  shifts. The hop draws above the box.
- With `prefers-reduced-motion: reduce`, nothing moves. Each state keeps a
  still pose, so the state still shows.
- The colors follow `prefers-color-scheme`. Set `--fox-fur`, `--fox-cream` and
  `--fox-ink` on `.fox-mascot` to change them, for example for a theme set by
  a class instead of the OS. The fur keeps 3:1 against the
  fox look's page colors in both themes.

foxkit has a CLI (`create-foxkit`) and a library. It has no MCP server.

## Delivery and behavior limits

- The template fixes pnpm, TypeScript, Node.js, and GitHub Actions. There is no template update command.
- Generated source is a scaffold, not your finished package or extension.
- Change the generated author, license attribution, extension behavior, and listing before release.
- Remote mode requires Manifest V3, `ICHABOD_API_KEY`, and `cloudflared`.
- Remote mode refuses custom Firefox paths, preferences, and visible browser windows.
- Remote navigation has a 60-second limit and one retry for timeout or network errors.
- Remote connection attempts stop after three tries; each defaults to 45 seconds.
- The frame relay supports `browser.*`; unsupported namespaces and user-gesture calls can fail.
- Remote mounts share one public origin. WebSocket upgrades are not forwarded.
- Mounted servers remain public until closed. Protect private fixture data yourself.
- Artifact names use UTC dates. Another same-day write with the same name replaces the file.
- AMO submission needs credentials and review. It does not guarantee a signed extension.
- npm release needs `NPM_TOKEN`; AMO submission needs `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`.

## Integration guides

- [Firefox extension quickstart](#create-your-first-repo): scaffold, install, and run a browser test.
- [Ichabod remote Firefox setup](#remote-mode-ichabod): credentials, tunnel setup, and frame restrictions.
- [Fox mascot setup](#the-fox-mascot): inline SVG, CSS states, and accessibility.

## Status

Version 0.1.7 is an early release. APIs and template defaults can change before 1.0.
Use [GitHub issues](https://github.com/pooriaarab/foxkit/issues) for support.
Public case studies are not yet published in this repository.

## FAQ

### What is foxkit?

foxkit creates TypeScript repositories and provides a Firefox extension test library.
Use the CLI for new projects or install the library in an existing project.

### Which integrations are verified?

foxkit contains seven integration entries listed above, with implementation and template statuses.
This rewrite verifies source paths and local checks, without a credentialed Ichabod or AMO run.

### Does foxkit provide a managed browser service?

foxkit provides a client for Ichabod and a local Firefox harness.
You supply service credentials or install Firefox yourself.

### How is foxkit different from Yeoman?

foxkit ships a fixed package template and a Firefox test harness.
Yeoman runs generators selected from its ecosystem.

### Can foxkit test Chrome extensions?

foxkit targets Firefox through WebDriver BiDi.
It does not provide a Chrome test mode.

### Does foxkit update generated repositories?

foxkit copies the template once.
Apply future workflow and source changes yourself.

### Does foxkit load my .env file?

foxkit reads process environment variables.
Export them in your shell or load them before starting Node.js.

### Can I use foxkit without Ichabod?

foxkit defaults to local Firefox.
Set `FIREFOX` only when its binary is outside the normal search paths.

## Development

```bash
pnpm install --frozen-lockfile
pnpm ci:local
pnpm e2e
pnpm e2e:ichabod
```

The local gate runs lint, typecheck, unit tests, and build.
Browser tests run separately; Ichabod tests require credentials and `cloudflared`.

## License

[MIT](https://opensource.org/license/mit)
