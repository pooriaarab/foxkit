# Failure modes

This file lists every way a foxkit part can fail. Each failure mode has a
test or an E2E check. The test comes first, then the code.

## The create-foxkit command

The command writes files into a directory that the user names. A mistake can
destroy work or create a repo that looks correct but is not. The command must
refuse bad input before it writes anything.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| C1 | The name is missing, or there are two names. | Exit 2. Show the usage. Write nothing. | `tests/cli.test.ts` |
| C2 | The name is not a safe directory and repo name (uppercase, a space, a slash, `..`, more than 60 characters). | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C3 | `--prefix` is missing, or it is not 2 to 5 lowercase letters. | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C4 | `--description` is missing, empty, has a line break, or is longer than 120 characters. | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C5 | `--package` is not a valid npm package name. | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C6 | A flag is unknown, for example `--extention` or `-p`. | Exit 2. Write nothing. A typo must not be ignored. | `tests/cli.test.ts` |
| C7 | A flag has no value (`--prefix` at the end, or `--prefix --description x`). | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C8 | The target directory exists and has files in it. | Exit 2. Do not change the files that are there. | `tests/cli.test.ts` |
| C9 | The target path exists and is a file. | Exit 2. Do not change the file. | `tests/cli.test.ts` |
| C10 | The target directory exists and is empty. | Use it. This is not a failure. | `tests/cli.test.ts` |
| C11 | The description has characters that break JSON or a replace call: `"`, `\`, `$&`. | `package.json` stays valid JSON and holds the exact text. | `tests/cli.test.ts` |
| C12 | A placeholder such as `__NAME__` stays in a generated file. | No generated file holds a placeholder. An unknown placeholder in the template stops the command before it writes. | `tests/cli.test.ts` |
| C13 | npm drops `.gitignore` from a published package, so the new repo has none. | The template stores `_gitignore`. The command writes it as `.gitignore`, also with Windows path separators. | `tests/cli.test.ts` (macOS and Linux only) |
| C14 | The new repo has no Git repository, or its branch is not `main`. | The command runs `git init -b main`. If Git fails, exit 1 and say why. | `tests/cli.test.ts` |
| C15 | The user does not know what to do next. | The command prints the next steps: `cd`, `pnpm install`, `pnpm ci:local`. | `tests/cli.test.ts` |

## The --extension option

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| C16 | A repo made without `--extension` gets the demo extension, the `e2e` script, or the E2E CI job. | It gets none of them. | `tests/cli.test.ts` |
| C17 | A repo made with `--extension` lacks the demo extension, the `e2e` script, the `create-foxkit` dev dependency, or the E2E CI job. | It has all four. | `tests/cli.test.ts` |
| C18 | A `foxkit:extension` marker line stays in a generated file. | No file holds a marker. An unclosed marker in the template stops the command before it writes. | `tests/cli.test.ts` |
| C19 | The extension's gecko ID breaks the MDN rules: the pattern `^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$`, at most 80 characters. | The ID is `<name>@<owner>`. When it is longer than 80 characters, exit 2 and write nothing. | `tests/cli.test.ts` |
| C20 | `--foxkit` is given without `--extension`, so it does nothing. | Exit 2. Write nothing. Without `--foxkit`, the dev dependency is `^<this create-foxkit version>`. | `tests/cli.test.ts` |

## The listed extension (`--extension`)

Every fox repo ships an extension that shows its primitive. The release
submits it to AMO as a listed add-on, and the GitHub release links to the
listing.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| C21 | The manifest breaks a Firefox fact from the BRIEF: no `strict_min_version` of `153.0`, no `data_collection_permissions`, or no page to show the primitive. | The manifest has all three. The page is an `action` popup. | `tests/cli.test.ts` |
| C22 | `ci:local` does not build the extension or does not run `web-ext lint`, so a broken extension passes CI. | `ci:local` runs `build:ext` (esbuild to `dist-ext/`) and `lint:ext` (`web-ext lint`). | `tests/cli.test.ts`; `scripts/e2e.mjs` runs it |
| C23 | The manifest version differs from the `package.json` version, so AMO signs one version and npm publishes another. | `build:ext` exits 1 and names both versions. `release.yml` runs it through `ci:local`. | `scripts/e2e.mjs` changes the version and expects exit 1 |
| C24 | `release.yml` publishes without an AMO submission, submits with an empty secret, sends no source or no listing, waits for an AMO review that takes days, or reports success when web-ext did not submit. | The extension variant runs `web-ext sign --channel=listed --amo-metadata` with `--approval-timeout=0`, fails when `AMO_JWT_ISSUER` or `AMO_JWT_SECRET` is empty, uploads `git archive` source, fails unless web-ext logs that it skipped the wait for approval, and makes a GitHub release that says "Submitted for AMO review" with no `.xpi`. A plain repo has no AMO step. | `tests/cli.test.ts` |
| C25 | Build output (`dist-ext/`, `web-ext-artifacts/`) gets committed. | `.gitignore` lists both in the extension variant. | `tests/cli.test.ts` |
| C26 | A PNG icon goes through the text renderer and comes out broken, or the manifest has no 48, 96 or 128 px icon. | Files that are not text are copied byte for byte. The manifest names `icons/icon-48.png`, `icon-96.png` and `icon-128.png`, and the action uses them. | `tests/cli.test.ts` |
| C27 | The AMO listing is missing, breaks an AMO rule, or a user sees "demo" in the add-on name, the action title or the popup title. | The repo has `extension/amo-metadata.json` and `scripts/amo-listing.mjs`. `ci:local` runs `check:amo`, which checks the listing and the manifest. The name and titles are the repo name. | `tests/cli.test.ts`; `scripts/e2e.mjs` runs `ci:local` |
| C28 | `amo-metadata.json` ships inside the add-on. | `build:ext` leaves it out of `dist-ext/`. | `scripts/e2e.mjs` |

## The E2E harness (`create-foxkit/e2e`)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| H1 | Firefox is not at the path. | `launch()` throws an error that names the path and the `FIREFOX` variable. It starts nothing. | `tests/e2e.test.ts` |
| H2 | The extension directory has no `manifest.json`, or the manifest has no `browser_specific_settings.gecko.id`. | `launch()` throws an error that names the file. It starts nothing. | `tests/e2e.test.ts` |
| H3 | WebDriver BiDi refuses `moz-extension:` pages. | `launch()` always passes `-remote-allow-system-access` to Firefox. | `scripts/e2e.mjs` reads the fixture page |
| H4 | `goto()` never resolves on a `moz-extension:` page, because BiDi sends no navigation events for it. | `openExtensionPage()` does not wait for `goto()`. It polls `location.href` and `document.readyState`. | `scripts/e2e.mjs` reads the fixture page |
| H5 | A condition never becomes true. | `poll()` throws after its timeout, and the error names the timeout. It does not hang. | `tests/e2e.test.ts` |
| H6 | `close()` leaves Firefox running or the temporary profile on disk, or a second `close()` throws. | `close()` stops Firefox and deletes the profile. A second call does nothing. | `scripts/e2e.mjs` checks the profile is gone |
| H7 | `launch()` fails after Firefox starts, for example when the extension does not install. | `launch()` closes Firefox and deletes the profile, then throws. | Not tested: it needs a Firefox that fails on purpose. |
| H8 | `serve()` returns a file outside its directory for a path such as `/../package.json`. | It answers 404. | `tests/e2e.test.ts` |
| H9 | `serve()` gets a path for a file that does not exist. | It answers 404. | `tests/e2e.test.ts` |
| H10 | `writeArtifact()` gets a directory that does not exist, or writes a file name that changes on each run of the same day. | It creates the directory. It writes `<name>-<YYYY-MM-DD>.json` with valid JSON. | `tests/e2e.test.ts` |
| H11 | A function given to `page.evaluate()` uses a variable from outside it. | Nothing can catch this at run time: the function runs in the page, without its closure. The README says to pass values as arguments. | README |
