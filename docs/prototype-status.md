# Prototype status — what is verified and what is a guess

Written 2026-09-12; updated the same day after installing Dagger v0.21.9 and running M0
against a real engine.

**M0 through M4 are verified, with one honest gap in M4** (see below). The module loads on a real engine, the fixture builds and
serves its SHA, `pre`/`build`/`test` run as Dagger stages, and the `db` gate has been driven
through seven scenarios — index, rename, destructive rewrite, waivers correct and incorrect —
each with the observed result recorded in `docs/runbooks/m3-db-gate-scenarios.md`.

The assumption the whole linting gate rested on has now been measured, and it held: Squawk
reports **nothing at all** for a column-dropping migration when that migration is wrapped in
`DO $EF$` blocks. Linting the non-idempotent script is not a preference.

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
| **M3**: Squawk's image, flag, fields | npm `squawk-cli@2.65.0`; `--reporter json`; fields `rule_name`, `file`, `line`, `level`, `message`, `help` |
| **M3**: `line` is zero-based | a finding on the first line arrives as 0; the parser now adds 1 |
| **M3**: the `DO $$` false green | same migration: 3 findings plain, **0** idempotent |
| **M3**: seven `db` gate scenarios | see `docs/runbooks/m3-db-gate-scenarios.md` |
| **M3**: apply-to-copy against a seeded database | baseline + 3 seed rows + pending, snapshots compared via `information_schema` |
| `dag.currentModule().source()` | used to ship the default Squawk config |
| **M4**: branch gating | `--branch=dev` with `defaultBranch: main` → push skipped, run green |
| **M4**: `publish: false` | push skipped as a decision, with the reason in the report |
| **M4**: push needs an image | `--stage=push` alone skips rather than publishing a stale image |
| **M4**: the publish call itself | reached a real registry: `HEAD /v2/shipkit-fixture/blobs/sha256:…`, address and tag correct |
| **M4**: unauthenticated push fails usefully | GHCR's token endpoint rejected it; exit 3, `next` says no token was provided |
| **M4**: the token is passed by reference | `--registry-token=env:SHIPKIT_REGISTRY_TOKEN` — the value never becomes an argument |
| **M4**: module resolution | no `kit:` → local module; `kit:` → `-m <ref>`; `--module` overrides |
| `withExec({ expect: ReturnType.Any })` | verified on the Squawk step |
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

### And one in the wrapper

`shipkit ci` was passing a **git SHA** to `--migration-base`, which expects a **migration id**.
EF answered "the migration 'aeab9b5…' was not found" — loudly, thankfully. Decision D4 says
"last migration id present on main, from `git merge-base`", and the wrapper had taken the
merge-base commit itself. It now reads the migration files present at that commit and takes
the newest id, which is argument translation — the wrapper's actual job.

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

### A third fail-open, and a design the marker forced open

The published Squawk image has no `linux/arm64` manifest: it would have worked on CI and
failed on every Apple Silicon laptop. Squawk now comes from npm, which ships native binaries
for both, pinned to an exact version — a linter that silently gains or loses a rule changes
what the gate means.

The bigger correction was to the intent marker. It began as `shipkit:destructive-ok`, a
blanket "this migration is fine", which had two faults: a waiver obtained for one column let
an unrelated second loss ride along inside the same migration, and it could not waive Squawk
at all — so an intentional, reviewed drop could never ship, and the realistic outcome was
someone deleting `ban-drop-column` from the config for every migration forever.

It is now `shipkit:allow-loss <target>`: it must name what is being destroyed, it applies
uniformly to Squawk, the grep scan and apply-to-copy, it is matched per statement rather than
per file, and a marker that waives nothing is itself a failure (the stale-allowance gate),
so markers cannot be added preemptively.

### And one in the wrapper

`shipkit ci` was passing a **git SHA** to `--migration-base`, which expects a **migration id**.
EF answered "the migration 'aeab9b5…' was not found" — loudly, thankfully. Decision D4 says
"last migration id present on main, from `git merge-base`", and the wrapper had taken the
merge-base commit itself. It now reads the migration files present at that commit and takes
the newest id, which is argument translation — the wrapper's actual job.

### The CLI had never been committed

The `.gitignore`'s .NET section carried a bare `bin/`, which matches at any depth — including
this repository's own `bin/`, where the wrapper lives. Four commits went out without the
kit's entry point. A clone would have had no `shipkit` command, and the kit's own workflow,
which runs `node ../../bin/shipkit ci`, would have failed on its first run.

Found by noticing that `git status` did not list a file that had certainly changed. The rule
is now scoped to `**/src/**/bin/` and `**/tests/**/obj/` and the like, and .NET output is
still ignored.

Worth remembering as a class: the checks in this repository all examine what the pipeline
*does*. Nothing was watching what it *ships*.

### The M4 gap, stated plainly

**An authenticated push to GHCR has never run.** The `gh` token on this machine has scopes
`repo, read:org, gist, project, admin:public_key` — no `write:packages` — so there is no
credential here that could complete one, and obtaining one is not something to do on someone's
behalf.

What *is* verified is everything up to the credential: the address, the tag, the auth wiring,
and a real request to GHCR's token endpoint that came back rejected for the right reason. The
remaining unknown is one `withRegistryAuth` call with a working token.

It verifies itself on the first merge to `main` in a client repo: the workflow passes
`secrets.GITHUB_TOKEN`, which carries `packages: write` by default, so no PAT is needed.
A local check, if wanted sooner, needs a PAT with `write:packages` in
`SHIPKIT_REGISTRY_TOKEN` and `publish: true`.

A local HTTP registry was tried first and refused — Dagger speaks HTTPS to registries, and
the SDK's `registryService` publish option exists but adding it to production code purely to
make a test possible is test scaffolding in the wrong place.

### Still unverified

| Assumption | Where | How to check |
|---|---|---|
| An authenticated registry push | `core/push.ts` | first merge to main, or a PAT |
| A client repo consuming the kit as a remote module (`-m github.com/…`) — the repo is private, so Dagger needs git auth | `bin/shipkit` | M7, with `shipkit init` |
| `applyArtifact` / migration bundles — never built or run | `adapters/dotnet.ts` | M6 |
| Everything in `core/deploy.ts` | — | M6 |

### Known limitation, recorded deliberately

`allow-loss` can waive the destruction of a column that still holds data — scenario E does
exactly that, on a column with three rows behind it. The protections are that the author must
name the column, the marker is visible in review, and the run prints what it permitted along
with the row count. What the gate cannot do is tell a reviewed decision from a careless one.
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

`ci` is complete. M5 — server preparation — is the only thing standing between here and a
working deploy, and it cannot start until the hosting target is chosen. Nothing else in the
plan is blocked on anything but that decision.
