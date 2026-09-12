# Prototype status — what is verified and what is a guess

Written 2026-09-12; updated the same day after installing Dagger v0.21.9 and running M0
against a real engine.

**M0, M1 and M2 are verified.** The module loads on a real engine, the fixture builds and
serves its SHA, and `pre`, `build` and `test` now run as Dagger stages — green on the fixture,
red on deliberate breakage, with the right exit code either way. `db` is next (M3).

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
| **M0 done #1**: the module loads and exposes its functions | `dagger functions` lists ci, db-lint, db-pending, deploy, deploy-plan, doctor — JSDoc became the descriptions |
| **M0 done #2**: a missing config fails as a message, not a trace | `shipkit doctor` with no shipkit.yaml → *"shipkit.yaml not found"*, exit 2 |
| `doctor` happy path | valid config → all checks ok, exit 0 |
| `doctor` catches a missing Dockerfile | → `MISSING (Dockerfile)`, exit 2 |
| `doctor` rejects an unknown stack | `stack: rails` → *unknown stack "rails"*, `next: Supported: dotnet, nest, next, custom`, exit 2 |
| `--raw` escape hatch | `shipkit --raw doctor --source=…` passed straight through to `dagger call` |
| `doctor` against the real fixture | all checks ok, exit 0 |
| **M1 done #1**: `dotnet test` passes via Testcontainers | 3 tests, real PostgreSQL 17 |
| **M1 done #2**: compose serves the baked SHA | `GIT_SHA=a1b2c3d4e5f6` → `{"status":"ok","version":"a1b2c3d4e5f6"}` |
| Container HEALTHCHECK reaches healthy | `docker compose ps` → `Up 25 seconds (healthy)` |
| No migration at startup | `/orders` → 500 before `database update`, 200 after; `/health` 200 throughout |
| `-warnaserror` is a real gate | it failed the build on NU1903 in the template's OpenAPI package |
| `dotnet ef` multi-project form | `--project src/Infrastructure --startup-project src/Api` works, given Design in the startup project |
| `migrations list` output parsing | the `^\d{14}_` match separates ids from connection warnings and the trailing note |
| `migrations script <from>` → HEAD | verified; `0` means "from the beginning" |
| **M2 done #1**: `pre`, `build`, `test` green in Dagger | `pre` 0.2s cached, `build` tagged `sha-<short>`, `test` 3/3 |
| **M2 done #2**: format drift fails `pre` | `dotnet format` reported the exact file and column; exit 1 |
| **M2 done #3**: a failing test fails `test` | reported as `1 of 3 test(s) failed`; exit 1 |
| **M2 done #4**: `pre` is cached | 97s first run, 0.2s second |
| The Postgres service binding works | tests reported 3/3, which they could not have done without a database |
| `source.dockerBuild({ dockerfile, buildArgs })` | verified |
| The wrapper renders a real run end to end | stage table, tag, test counts, failing command, reason |
| Dagger TS SDK API shape | the decorators, `defaultPath`, `ignore`, and the argument forms all compiled and ran |
| The `yaml` dependency resolves inside the module | config parsing worked at runtime |

**A bug was found this way.** The intent marker (D6) was matched against raw lines, so
`INSERT INTO notes VALUES ('-- shipkit:destructive-ok')` disabled the destructive-SQL gate
for the whole script — a fail-open hole reachable by anyone who could write a row of seed
data. Noise is now stripped before the marker is matched. This is the argument for keeping
pure logic in `core/sql-scan.ts`, out of reach of Dagger imports: the gate most likely to
lose client data is the one that must be testable without Docker.

## Not verified — assumptions that will break first

### Corrected when the engine ran

Three guesses were wrong, all of them scaffolding rather than logic:

| Guess | Reality |
|---|---|
| `engineVersion: v0.18.6` | `v0.21.9` — the installed CLI's version |
| tsconfig path `./sdk/src/index.ts` | `./sdk/index.ts`, plus a second path for `@dagger.io/dagger/telemetry` |
| `@dagger.io/dagger: ./sdk` as a dependency in `.dagger/package.json` | `dagger develop` removes it and pins `typescript` instead |

`dagger develop` rewrites `.dagger/package.json` and `.dagger/tsconfig.json` and generates
`.gitignore`, `.gitattributes` and `yarn.lock`. Do not hand-maintain those four files.

### Still unverified

### A second fail-open found, this time by running things

`dotnet ef migrations add` does not rebuild. A later `--no-build` command therefore reads a
stale assembly, finds no migration, and writes a script containing nothing — and an empty
script passes Squawk, passes the destructive scan, and passes apply-to-copy. Every gate green,
nothing inspected.

Worse, a script with nothing pending is byte-identical to that failure: three bytes of UTF-8
BOM. The file alone cannot tell the two apart.

Fixed in two places: the adapter now builds before generating a script, and `dbStage`
cross-checks the migration list against the SQL — if migrations are pending but the script
carries no schema change, that contradiction fails closed (`emptyScript` gate).

Both fail-opens found so far (this one and the string-literal marker) were in the `db` stage.
That is the stage that decides whether a client keeps their data.

### Two more design faults, both found by running stages

**Failures reported nothing.** The first `pre` failure said only `exit code: 1`. Dagger's
`ExecError` carries the command and both streams, and the report was throwing them away —
one debugging round trip per failure, forever. Now the failing command and the relevant
output lines are on the stage entry. Both streams are read, because .NET writes build and
test failures to stdout, not stderr.

**Every failure was exit code 3.** A format violation was being reported as an
infrastructure problem. An `ExecError` means a command ran and said no — that is a gate, exit
1. Only errors that are not `ExecError` and not `ShipkitError` are the environment failing.
Since the exit code is the entire contract for a non-human caller, this made the contract
meaningless.

A third, smaller one: `dotnet test` exiting 0 having discovered nothing would have been a
pass. The adapter now parses the runner's summary and the core fails on zero tests.

### Still unverified

| Assumption | Where | How to check |
|---|---|---|
| `withExec({ expect })` | `core/db.ts` (Squawk) | M3 |
| Squawk's image, JSON reporter flag, and field names | `core/db.ts` | M3 |
| **Squawk does not see statements inside `DO $$`** | the whole reason we lint the non-idempotent script | M3 — still theoretical |
| `applyArtifact` / migration bundles | `adapters/dotnet.ts` | M6 |
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

## Environment

Dagger v0.21.9 is installed at `~/.local/bin/dagger` (user-local, no sudo). Docker Desktop
29.4.0 provides the engine. The first `dagger develop` pulls the engine image and takes
about a minute; afterwards it is cached.

## Next

M3 — the `db` stage. It already fails on something real: the fixture carries a local tool
manifest (`dotnet-tools.json`), which shadows the adapter's global `dotnet-ef` install and
makes EF demand `dotnet tool restore`. The adapter has to handle both arrangements, because
client projects will have both.

M3 also holds the checkpoint that the entire linting gate rests on: whether Squawk really
does miss statements wrapped in `DO $$` blocks. Until that is observed, the reason for
linting the non-idempotent script is an assumption.
