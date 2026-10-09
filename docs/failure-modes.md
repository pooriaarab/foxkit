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
| C2 | The name is not a safe directory and repo name (uppercase, a space, a slash, `..`). | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C3 | `--prefix` is missing, or it is not 2 to 5 lowercase letters. | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C4 | `--description` is missing, empty, has a line break, or is longer than 120 characters. | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C5 | `--package` is not a valid npm package name. | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C6 | A flag is unknown, for example `--extention`. | Exit 2. Write nothing. A typo must not be ignored. | `tests/cli.test.ts` |
| C7 | A flag has no value (`--prefix` at the end, or `--prefix --description x`). | Exit 2. Write nothing. | `tests/cli.test.ts` |
| C8 | The target directory exists and has files in it. | Exit 2. Do not change the files that are there. | `tests/cli.test.ts` |
| C9 | The target path exists and is a file. | Exit 2. Do not change the file. | `tests/cli.test.ts` |
| C10 | The target directory exists and is empty. | Use it. This is not a failure. | `tests/cli.test.ts` |
| C11 | The description has characters that break JSON or a replace call: `"`, `\`, `$&`. | `package.json` stays valid JSON and holds the exact text. | `tests/cli.test.ts` |
| C12 | A placeholder such as `__NAME__` stays in a generated file. | No generated file holds a placeholder. An unknown placeholder in the template stops the command before it writes. | `tests/cli.test.ts` |
| C13 | npm drops `.gitignore` from a published package, so the new repo has none. | The template stores `_gitignore`. The command writes it as `.gitignore`. | `tests/cli.test.ts` |
| C14 | The new repo has no Git repository, or its branch is not `main`. | The command runs `git init -b main`. If Git fails, exit 1 and say why. | `tests/cli.test.ts` |
| C15 | The user does not know what to do next. | The command prints the next steps: `cd`, `pnpm install`, `pnpm ci:local`. | `tests/cli.test.ts` |

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
