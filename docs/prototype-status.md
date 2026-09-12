# Prototype status — what is verified and what is a guess

Written 2026-09-12, after the first prototype pass. **Nothing here has been run against a
real Dagger engine.** `dagger` is not installed on this machine and the Docker daemon was
not running, so no pipeline has ever executed.

This document exists so that the next session does not mistake "written" for "working".

## Verified

Actually executed, with output observed:

| What | How |
|---|---|
| All 12 TypeScript files parse | `node --experimental-strip-types --check` on each |
| `scanDestructive` / `parseSquawk` behaviour | 9 unit tests, `npm test` — 15/15 pass |
| `planToken` invalidation rules | 6 unit tests: new commit, prod moved, extra migration, changed SQL all invalidate; cosmetic fields do not |
| CLI `--help`, `--explain`, unknown command | run; `--explain ci` prints `dagger call ci --source=. --sha=…` |
| CLI exit codes 2, 3, 4 | `frobnicate` → 2, `ci` without dagger → 3, `deploy` without flags → 4 |

**A bug was found this way.** The intent marker (D6) was matched against raw lines, so
`INSERT INTO notes VALUES ('-- shipkit:destructive-ok')` disabled the destructive-SQL gate
for the whole script — a fail-open hole reachable by anyone who could write a row of seed
data. Noise is now stripped before the marker is matched. This is the argument for keeping
pure logic in `core/sql-scan.ts`, out of reach of Dagger imports: the gate most likely to
lose client data is the one that must be testable without Docker.

## Not verified — assumptions that will break first

| Assumption | Where | How to check |
|---|---|---|
| Dagger TS SDK API shape: `@object`/`@func`/`@argument`, `defaultPath`, `ignore`, `withExec({ expect })`, `asService({ useEntrypoint })` | `.dagger/src/index.ts`, `core/postgres.ts` | `dagger develop` regenerates `sdk/`; the first `dagger functions` will say |
| `dagger.json` `engineVersion` | `dagger.json` | pinned by guess; `dagger init` writes the real one |
| Squawk's JSON reporter flag and field names | `core/db.ts`, `core/sql-scan.ts` | M3. Unparseable output already fails closed |
| **Squawk does not see statements inside `DO $$` blocks** | the reason the non-idempotent script is linted | M3 checkpoint. Until observed, the false-green risk (§7.2) is theoretical, and so is the gate |
| `dotnet ef migrations script <from> <to>` argument form for "from X to HEAD" | `adapters/dotnet.ts` — the empty-string filter is a placeholder | M3, against the fixture |
| `dotnet ef migrations list` output format (the `^\d{14}_` match) | `adapters/dotnet.ts` | M3 |
| `dotnet tool install --global` + PATH expansion in a Dagger container | `adapters/dotnet.ts` | M2/M3 |
| `source.dockerBuild({ buildArgs })` argument shape | `index.ts` build stage | M2 |
| GHCR image name for Squawk | `core/db.ts` | M3 |

## Deliberately not implemented

These throw `EXIT.NOT_IMPLEMENTED` (5) rather than returning a neutral result, so a
half-built pipeline can never report success:

- `apply-to-copy` with seeded row/column assertions — M3, the strongest rename-trap mitigation
- `push` to GHCR — M4
- every `deploy` stage: backup, migrate, release, verify, rollback — M6
- `deployPlan` reading production state — M6

## First things to do when Dagger is installed

1. `dagger develop` in the repo root — regenerates `sdk/` and fixes the SDK import path.
2. `dagger functions` — the M0 definition of done: `ci` and `deploy` must be listed.
3. `shipkit doctor` in a directory without `shipkit.yaml` — must print *"shipkit.yaml not
   found"* and exit 2, not a stack trace.
4. Then M1: the fixture project, which is what everything after it is tested against.
