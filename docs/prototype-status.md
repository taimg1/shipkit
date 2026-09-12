# Prototype status — what is verified and what is a guess

Written 2026-09-12; updated the same day after installing Dagger v0.21.9 and running M0
against a real engine.

**M0 and M1 are verified.** The module loads on a real engine, configuration failures behave
as designed, and the fixture project builds, tests against a real PostgreSQL, and serves its
commit SHA from `/health` in a container. No `ci` STAGE has run yet — the Dagger stages
themselves are M2.

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

### Still unverified

| Assumption | Where | How to check |
|---|---|---|
| `withExec({ expect })`, `asService({ useEntrypoint })` | `core/db.ts`, `core/postgres.ts` | not reached yet — no Dagger stage has run |
| That the adapter's containers work at all (restore, lint, test, tooling) | `adapters/dotnet.ts` | M2 — the commands are verified on the host, not yet inside Dagger |
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

M2 — `pre`, `build` and `test` as Dagger stages, run against `fixtures/dotnet-api`. Every
command in those stages has now been verified on the host; M2 is about whether they behave
the same inside a container, with caching and a service binding.
