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
