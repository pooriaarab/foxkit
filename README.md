# foxkit

The template for fox repos: shared CI, Firefox E2E tests, and npm release.

foxkit has two parts. The `create-foxkit` command makes a new TypeScript repo
that is ready for CI and npm release. The `create-foxkit/e2e` library starts a
real Firefox with your extension installed, so a test can check what the
extension does.

## Install

```bash
npm i -D create-foxkit
```

You need this only for the E2E library. To make a repo, use `npm create`, as
the next section shows.

## Example

Make a repo with a test extension, then run its checks and its Firefox test:

```bash
npm create foxkit@latest foxdemo -- --prefix fdm --description "Say what foxdemo does in one sentence." --extension
cd foxdemo
pnpm install
pnpm ci:local
pnpm e2e
```

`pnpm e2e` builds `dist-e2e/` and runs `e2e/run.mjs`. This is the core of it.
It runs as written in a repo made with `--extension`, after
`node scripts/build-ext.mjs --e2e`:

```js
import { launch, poll, serve, writeArtifact } from "create-foxkit/e2e";

const site = await serve("e2e/site");
const fox = await launch({ extension: "dist-e2e" });
try {
  const page = await fox.open(`${site.url}/index.html`);
  const value = await poll(page, () => document.documentElement.dataset.fixture);
  console.log(writeArtifact("artifacts", "e2e", { value }));
} finally {
  await fox.close();
  await site.close();
}
```

## What a new repo gets

| Path | What it does |
|---|---|
| `package.json` | pnpm, ESM, Node 24 or later. Scripts: `build`, `typecheck`, `lint`, `test`, `ci:local`. |
| `tsconfig.json`, `.oxlintrc.json`, `vitest.config.ts` | TypeScript, oxlint and vitest. `pnpm ci:local` runs lint, typecheck, test and build. |
| `src/index.ts` | A one-line library. Replace it with your code. |
| `README.md` | The ten sections every fox repo has. Each part to write starts with `FILL:`. |
| `AGENTS.md` | The PR rules for your prefix, the layout and the commands. |
| `docs/failure-modes.md` | Where you list how the code can fail, before you write it. |
| `.github/workflows/ci.yml` | Runs `pnpm ci:local` on each pull request and each push to `main`. |
| `.github/workflows/release.yml` | On a push to `release`: refuses a version that has a tag, runs `pnpm ci:local`, publishes to npm with provenance, then tags `v<version>` and creates a GitHub release. |
| `.github/workflows/pr-standards.yml` | Checks the branch, title, body and size of each pull request. |
| `.github/ISSUE_TEMPLATE/`, `.agents/issues.md` | Bug, feature, chore and epic forms, and the issue rules. |
| `LICENSE` | MIT. |

With `--extension`, the repo also gets these:

| Path | What it does |
|---|---|
| `extension/` | A Manifest V3 extension for Firefox with an `action` popup that the repo fills in to show its primitive. Its name and titles are the repo name, and it has 48, 96 and 128 px icons. The gecko ID is `<name>@<owner>`, `strict_min_version` is `153.0`, and it declares `data_collection_permissions`. Its background script stores a value. It has no content script. |
| `scripts/build-ext.mjs` | Bundles `extension/` into `dist-ext/` with esbuild: the release build that AMO gets. With `--e2e` it writes `dist-e2e/` instead, which adds the E2E content script from `e2e/extension/`. It stops when the manifest version is not the `package.json` version. |
| `build:ext`, `lint:ext` scripts | `pnpm ci:local` also builds `dist-ext/` and runs `web-ext lint --warnings-as-errors` on it. |
| `extension/amo-metadata.json`, `scripts/amo-listing.mjs`, `check:amo` script | The AMO listing: name, summary, description, category, MIT license, links and notes for reviewers. `pnpm ci:local` runs `check:amo`, which stops on a listing that AMO refuses, on "demo", "test" or "fixture" in text that users see, on a manifest that declares data collection without a `privacy_policy`, and on a test-only piece in `dist-ext/`: a content script or host permission for `127.0.0.1`, `localhost` or `*.localhost` (unless `local_hosts` in the listing gives a reason), or a file named `e2e`, `fixture`, `test` or `spec`. Edit the description before the first release. |
| `e2e/run.mjs`, `e2e/site/`, `e2e/extension/` | The E2E test. It installs `dist-e2e/`, checks that the E2E content script marks a page on `127.0.0.1` and that the background stored a value, and writes `artifacts/e2e-<date>.json`. |
| `e2e` script, `create-foxkit` dev dependency | `pnpm e2e` builds `dist-e2e/` and runs the test. |
| AMO steps in `release.yml` | After the npm publish, `web-ext sign --channel=listed --amo-metadata` submits `dist-ext/` and the listing with the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` secrets, and uploads the `git archive` source for AMO review. A listed version waits for review, so web-ext runs with `--approval-timeout=0` and returns after the upload. Before the upload, `amo-listing.mjs version-status` asks AMO for the version: when AMO already has it as listed, a re-run skips `web-ext sign` and finishes the release. `amo-listing.mjs after-submit` then sends the privacy policy (when there is one) and the listing icon. The GitHub release says "Submitted for AMO review" and links to the listing; it has no `.xpi`. An empty secret stops the job with a clear error. |
| `pnpm-workspace.yaml` | Allows the esbuild build script, which pnpm 11 blocks by default. |
| An `e2e` job in `ci.yml` | Installs Firefox with `browser-actions/setup-firefox` and runs `pnpm e2e`. |

All GitHub Actions are pinned to commit SHAs.

## Use cases

| Who | What they build | How foxkit helps |
|---|---|---|
| A developer who starts a Firefox extension | An MV3 extension with tests from day one | `--extension` gives an extension with an AMO listing, a Firefox E2E test that also runs in CI, and an AMO submission on release. |
| The fox primitives maintainers | foxmind, foxpaw, foxgate and the other fox repos | Each repo starts with the same CI, release workflow and PR rules. |
| An author of a small library for AI agents | A TypeScript package on npm | The release workflow publishes with provenance and refuses to publish a version twice. |
| A team with an extension that has no browser tests | Firefox E2E tests in their own repo | `npm i -D create-foxkit`, then use `launch()` and `poll()` from `create-foxkit/e2e`. |
| A fleet of coding agents | New repos, made with no person at the keyboard | The command has no prompts. It refuses bad input and writes nothing in that case. |
| A benchmark author | A task suite that scores browser agents in Firefox | `serve()` hosts local task pages. `writeArtifact()` keeps each result as JSON. |

## How it works

```mermaid
flowchart LR
  cli["npm create foxkit"] --> repo["New repo<br/>git init -b main"]
  repo -->|pull request| ci["CI<br/>pnpm ci:local + Firefox E2E"]
  ci -->|merge| main["main<br/>staging"]
  main -->|merge| rel["release branch<br/>release.yml"]
  rel --> npm["npm publish --provenance"]
  rel --> tag["tag vX.Y.Z<br/>GitHub release"]
```

The command reads `template/base` (and `template/extension` with
`--extension`) into memory and fills the placeholders. It writes the files
only when all input is valid, then runs `git init -b main`.

The E2E library drives Firefox through Puppeteer over WebDriver BiDi:

```mermaid
sequenceDiagram
  participant T as Your test
  participant H as create-foxkit/e2e
  participant F as Firefox
  T->>H: launch({ extension })
  H->>F: start with a new profile and -remote-allow-system-access
  H->>F: webExtension.install (temporary add-on)
  T->>H: open(url)
  H->>F: new tab, load url
  T->>H: poll(page, fn)
  H->>F: run fn in the page until it returns a value
  T->>H: openExtensionPage("popup.html")
  H->>F: load moz-extension://uuid/popup.html, poll until loaded
  T->>H: close()
  H->>F: stop Firefox, delete the profile
```

Two Firefox facts shape the library. WebDriver BiDi refuses `moz-extension:`
pages unless Firefox starts with `-remote-allow-system-access`. BiDi also sends
no navigation events for those pages, so `goto()` never resolves there. For
this reason `openExtensionPage()` polls `location.href` and
`document.readyState`.

## CLI

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

## API

The E2E exports come from `create-foxkit/e2e`. The fox mascot is in
`create-foxkit/fox`; see "The fox mascot".

| Export | What it does |
|---|---|
| `launch(options)` | Starts Firefox with a new profile and installs the extension as a temporary add-on. Returns a `Fox`. |
| `poll(page, fn, arg?, timeoutMs = 30000)` | Runs `fn(arg)` in the page until it returns a truthy value, and returns that value. Throws after the timeout. |
| `serve(dir, { tunnel? })` | Serves a directory on `http://127.0.0.1:<free port>`. Returns `{ url, close }`. Paths outside the directory get 404. In remote mode, `url` is a public URL on the shared tunnel. |
| `tunnel(port, { cloudflared?, timeoutMs?, signal? })` | Mounts `http://127.0.0.1:<port>` on the shared quick tunnel. Returns `{ url, close }`; `url` is `https://<random>.trycloudflare.com/_foxkit/<id>`. |
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

### Remote mode (Ichabod)

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

#### Extension pages on Ichabod

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

### The fox mascot

One animated fox for every fox* extension. It is an inline SVG that CSS moves;
no script runs. The SVG and the CSS together are under 3 KB.

| Export | What it is |
|---|---|
| `create-foxkit/fox.svg` | The drawing. Put it inline in the page, for example in a `<template>`. An `<img>` cannot animate it. |
| `create-foxkit/fox.css` | The colors, the poses and the motion. |
| `FOX_STATES` and `FoxState` from `create-foxkit/fox` | The states the CSS draws. |

Put the SVG in an element, and set `data-state` on that element. The SVG fills
the element, so the element sets the size.

```html
<span class="mascot" data-state="working" style="width: 96px; height: 96px"><!-- fox.svg --></span>
<span role="status">Working on example.com</span>
```

| `data-state` | What the fox does |
|---|---|
| `idle` (or no attribute) | Breathes, sways its tail, blinks, and twitches one ear every few seconds. |
| `thinking` | Looks up and tilts its head, with slow nods. |
| `working` | Reads: looks down and from side to side, with quick nods. |
| `success` | Happy eyes and one hop. Set it back to `idle` after a few seconds. |
| `error` | Ears out, head and tail down, one small shake. |
| `needs-approval` | Leans in, ears up, and looks down to the right, at the approval. |

- The SVG has `aria-hidden="true"`. Put the status in text next to it.
- `.fox-mascot` sets `stroke: none`, so a page rule that strokes its icons
  (`svg { stroke: currentColor }`) does not outline the fox.
- Only `transform` moves. The fox never changes its box, so nothing next to it
  shifts. The hop draws above the box.
- With `prefers-reduced-motion: reduce`, nothing moves. Each state keeps a
  still pose, so the state still shows.
- The colors follow `prefers-color-scheme`. Set `--fox-fur`, `--fox-cream` and
  `--fox-ink` on `.fox-mascot` to change them. The fur keeps 3:1 against the
  fox look's page colors in both themes.

foxkit has a CLI (`create-foxkit`) and a library. It has no MCP server.

## Firefox APIs used

| API | MDN | Why |
|---|---|---|
| WebDriver BiDi `webExtension.install` | [webExtension](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/webExtension) | `launch()` installs the extension as a temporary add-on. |
| WebDriver BiDi `script` module | [script](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/script) | `poll()` and `page.evaluate()` run functions in a page. |
| `-remote-allow-system-access` command-line flag | No MDN page | Lets BiDi reach `moz-extension:` pages. Ichabod does not set it. |
| `web_accessible_resources` with `matches` | [web_accessible_resources](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources) | Remote mode lets pages on the tunnel origin, and no other, frame the extension pages. |
| `runtime.connect` and `runtime.onConnect` | [runtime.connect](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/connect) | The frame relay sends calls and events between a framed page and the background page. |
| WebDriver BiDi `browsingContext.getTree` and `browsingContext.close` | [browsingContext](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browsingContext) | Remote mode reads the extension UUID from a tab URL, then closes the tab. |
| `extensions.webextensions.uuids` preference | No MDN page | Fixes the extension UUID, so the `moz-extension:` URL is known before the add-on loads. |
| `browser_specific_settings` (`gecko.id`, `data_collection_permissions`) | [browser_specific_settings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings) | The demo extension needs an ID and Firefox 153 (the current ESR). AMO requires the data collection key for new extensions. |
| `background.scripts` | [background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) | The demo extension's background script (an event page). |
| `content_scripts` | [content_scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts) | The demo extension marks each page on `127.0.0.1`. |
| `runtime.onInstalled` | [runtime.onInstalled](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onInstalled) | The demo extension stores its value at install time. |
| `action` popup | [action](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/action) | The page where a repo shows its primitive. The E2E test reads it. |
| `storage.local` | [storage.local](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local) | The demo extension stores a value and `popup.html` reads it. |

## Limits

- `create-foxkit` is not on npm until its first release. Until then, run the
  command from a checkout: `pnpm install && pnpm build`, then
  `node dist/cli.js <name> ...`.
- The template is fixed: pnpm, TypeScript, Node 24 or later, and GitHub
  Actions. There are no options for other tools.
- A repo does not get later template changes. There is no update command.
- `LICENSE` and the `author` field in `package.json` name Pooria Arab. Change
  both when the repo is yours.
- The E2E library works with Firefox only. It is tested with Firefox 157 on
  macOS.
- The E2E library installs temporary add-ons only. The AMO submission
  happens only in `release.yml`, and it has not run against AMO from this
  template yet.
- The release submits the extension after the npm publish. If the submission
  fails, run the release again: it skips the npm publish when that version is
  already on npm.
- AMO reviews a listed version before it signs it. The release does not wait
  for that review, so the signed file is on the AMO listing, not on the
  GitHub release.
- The release workflow needs the repository secret `NPM_TOKEN`. Without it,
  the publish step fails with a clear error.
- `writeArtifact()` names files by UTC date, so a second run on the same day
  replaces the file.

## Part of the fox primitives

foxkit depends on no fox repo. Every fox repo starts from it.

```mermaid
flowchart LR
  foxkit["foxkit"] --> foxbench & foxmind & foxpaw & foxgate & foxtrail & foxloop & foxlend & foxmate
  foxkit --> later["v2 and v3 repos"]
  click foxkit "https://github.com/pooriaarab/foxkit"
  click foxbench "https://github.com/pooriaarab/foxbench"
  click foxmind "https://github.com/pooriaarab/foxmind"
  click foxpaw "https://github.com/pooriaarab/foxpaw"
  click foxgate "https://github.com/pooriaarab/foxgate"
  click foxtrail "https://github.com/pooriaarab/foxtrail"
  click foxloop "https://github.com/pooriaarab/foxloop"
  click foxlend "https://github.com/pooriaarab/foxlend"
  click foxmate "https://github.com/pooriaarab/foxmate"
```

## Development

```bash
pnpm install
pnpm ci:local   # lint, typecheck, test, build
pnpm e2e        # scaffolds two repos and runs their checks and Firefox E2E
pnpm e2e:ichabod  # remote mode against Ichabod; needs ICHABOD_API_KEY and cloudflared
```

`pnpm e2e` writes `artifacts/e2e-<date>.json`, and `pnpm e2e:ichabod` writes
`artifacts/e2e-ichabod-<date>.json`. Set `FIREFOX` when Firefox is
not in the usual place.

## License

[MIT](LICENSE)
