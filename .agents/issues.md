# Writing issues in this repo

The standard is [issue-standards.md](https://github.com/pooriaarab/scripts/blob/main/issue-standards.md).
This file holds only what is specific to foxkit.

## Labels

Every issue carries exactly one label from each group.

| Group | Labels                                              |
| ----- | --------------------------------------------------- |
| Kind  | `bug` `feature` `chore` `epic`                      |
| Size  | `mini` `standard` `deep`                            |
| Route | `route:mechanical` `route:scoped` `route:judgement` |
| State | `triage` `ready-for-agent` `needs-info` `blocked`   |

## Success metrics

foxkit has no analytics helper and sends no events. A feature issue says so
and names the evidence instead: the E2E artifact in `artifacts/`, or the npm
download count of `create-foxkit`.

## High-stakes paths

An issue that touches one of these paths is `route:judgement`.

| Path | Why a mistake here is expensive |
| ---- | ------------------------------- |
| `template/base/.github/workflows/release.yml` | Every fox repo publishes to npm with it. |
| `.github/workflows/release.yml` | It publishes `create-foxkit` to npm. |
| `src/scaffold.ts` | It writes files into a directory the user names. |

## Parents and blockers are native

Use the sub-issues API for a parent and issue dependencies for a blocker. Do
not write `Parent: #NNNN` or `Blocked by: #NNNN` in the body.
