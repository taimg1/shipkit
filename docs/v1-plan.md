# v1 plan — the stable version

> `ci-cd-plan.md` says *why*. `multi-stack-plan.md` says *later*. This document says
> *what gets built now, in what order, and what "done" means for each step*.

## Scope

**v1 is:** one .NET + EF Core + PostgreSQL project goes from `git push` to production on a
bare server, with every gate from ADR 0004 in place and proven to fail closed, a verified
off-server backup, and an automatic rollback that has been seen to fire.

**v1 is not:** NestJS, Next.js, the `custom` adapter, `shipkit init`, templates, IaC,
monorepos. The `StackAdapter` seam exists in the code (it is cheap and §8 of the
multi-stack plan is enforced in review), but it has exactly one implementation.

"Stable" means: the fixture project in this repo has been deployed, broken on purpose in
each of the four gate scenarios, and recovered — and each of those runs is recorded in
`docs/runbooks/`. Not "the code looks finished".

---

## Decisions taken for v1

These were open in `ci-cd-plan.md` §13 or surfaced while planning. Closed here so that
building can start; each can be revisited with a new ADR.

| # | Decision | Choice for v1 | Why |
|---|---|---|---|
| D1 | What the kit is tested against | A minimal fixture in `fixtures/dotnet-api/` (Web API + EF + one entity + `/health`), **plus** one real project once M4 is green | The fixture makes the kit's own CI possible; the real project is what proves it |
| D2 | Real Postgres in `test` — Testcontainers or a Dagger service? | **Dagger service** binding, injected as `ConnectionStrings__Test`. The project's test fixture uses that env var when present and falls back to Testcontainers when absent (developer laptop) | Testcontainers inside a Dagger container needs a Docker socket, which breaks isolation and reproducibility. One test fixture, two transports |
| D3 | Confirmation UX for `deploy` | **Non-interactive.** `deploy --plan` prints target, image, pending migrations, SQL diff and exits 0. `deploy --yes` executes. `deploy` with neither prints the plan and exits non-zero with "re-run with --yes" | Blocking on stdin inside Dagger is awkward and unusable from another program. Same information, no prompt |
| D4 | Base for the migration diff in `ci` | Last migration id present on `main` (from `git merge-base`). No migrations on `main` yet → full script | Linting every historical migration on every push re-fails old migrations against new rules. Lint what the PR adds |
| D5 | Where the last-deployed-migration marker lives | **Read back from production `__EFMigrationsHistory`** during `deploy`. No separate store | One fewer thing to keep in sync. Closes a §13 open question |
| D6 | How a destructive migration is marked intentional | The migration emits `migrationBuilder.Sql("-- shipkit:destructive-ok <reason>")`; the marker lands in the generated SQL and the grep gate honours it | The annotation travels with the SQL, is visible in review, and needs no side file |
| D7 | Backup verification depth | `pg_dump -Fc`, then: size above threshold **and** `pg_restore --list` succeeds **and** restore into a scratch Postgres service with a table count > 0 | Non-empty is not the same as restorable. The restore is the only real proof |

Still open, and *needed before M5*: hosting provider; managed vs. containerised Postgres;
one server per client vs. shared; where Uptime Kuma runs (the existing Proxmox host is the
obvious candidate). Nothing before M5 depends on them.

---

## Milestones

Each milestone is independently useful and has a definition of done that is a test, not a
feeling. Sizes are relative (S/M/L), not dates.

### M0 — Module skeleton · S

- `dagger init --sdk=typescript` at repo root. Layout:
  ```
  .dagger/src/
    index.ts          # exports ci(), deploy()
    config.ts         # parse + validate shipkit.yaml; fail loudly if missing
    core/             # stages that never mention a stack
      pre.ts build.ts test.ts db.ts push.ts
      backup.ts migrate.ts release.ts verify.ts rollback.ts clean.ts
      gates.ts        # the four gates, as functions that throw
    adapters/
      types.ts        # StackAdapter, DbAdapter
      dotnet.ts       # the only implementation in v1
  ```
- `shipkit.yaml` schema: `stack`, `db`, `delivery`, `health`, `project` (path to the
  startup project), `migrationsProject`.
- **Done when:** `dagger functions` lists `ci` and `deploy`; `dagger call ci --source=.`
  against an empty dir fails with *"shipkit.yaml not found"*, not a stack trace.

### M1 — Fixture project and local baseline · S

- `fixtures/dotnet-api/`: minimal Web API, one `DbContext`, one entity, one migration,
  `/health` returning `{ "status": "ok", "version": "<sha>" }` where the SHA is a build
  arg baked in at `dotnet publish` (`-p:InformationalVersion=$GIT_SHA`).
- Integration test project using the D2 fixture (env var → Dagger service, else Testcontainers).
- `Dockerfile` (multi-stage: `sdk` → publish → `aspnet` runtime, non-root user, `HEALTHCHECK`).
- `docker-compose.yml` with app + Postgres on a named volume.
- **Done when:** `docker compose up` → `curl :8080/health` returns the SHA; `dotnet test`
  passes locally via Testcontainers.

### M2 — `ci`: `pre` + `build` + `test` · M

- `pre`: restore with a cache mount; `dotnet format --verify-no-changes`;
  `dotnet build -warnaserror` so analyzers fail the build.
- `build`: publish inside the SDK container, produce the runtime image, tag `sha-<short>`.
  The adapter owns the Dockerfile path; the core owns the tag.
- `test`: core starts the Postgres service and binds it to the test container as
  `ConnectionStrings__Test`; adapter runs `dotnet test --no-build`.
- **Done when:** on the fixture — `dagger call ci` is green; a deliberate format drift →
  red at `pre`; a deliberately failing test → red at `test`; `pre` is cached on the second
  run (restore is not repeated).

### M3 — `ci`: `db` · L (the risky one)

- Diff base per D4. Adapter generates the **non-idempotent** script with
  `dotnet ef migrations script <base> <head>` in an SDK container with `dotnet-ef` installed.
- Squawk runs as a container on that file. Rule set in `.squawk.toml` in the client repo;
  the kit ships a recommended one in `fixtures/dotnet-api/.squawk.toml`.
- Destructive grep gate: `DROP COLUMN` / `DROP TABLE` / `ALTER COLUMN .* TYPE` fail unless
  the D6 marker is present.
- Apply-to-copy: fresh Postgres service → apply all `main` migrations → load
  `ci/seed.sql` if present → apply pending via the **bundle** → assert every table that
  existed before still exists with row count unchanged, and that every column in the seed
  is still present. This is the rename-trap test from `ci-cd-plan.md` §7.3, written once in
  the core against `information_schema`.
- **Explicit checkpoint, not optional:** add a fixture migration with a plain
  `CREATE INDEX` and confirm Squawk reports it on the non-idempotent script. Then generate
  the same migration with `--idempotent` and confirm whether Squawk still sees it. Record
  the answer in `docs/adr/0003` — this is the false-green risk from §7.2, and until it is
  observed the gate is theoretical.
- **Done when:** fixture with plain `CREATE INDEX` → red (Squawk); with
  `CONCURRENTLY` + `suppressTransaction` → green; a property rename → red (grep gate); the
  same rename with the D6 marker → red at apply-to-copy because the seed rows lost a column;
  a rename done properly as `RenameColumn` → green.

### M4 — `push` + thin trigger · S

- `push`: on `main` only, push `sha-<short>` to GHCR. Registry token arrives as a Dagger
  `Secret`, never as a plain string.
- `.github/workflows/ci.yml`: checkout, install pinned Dagger, `dagger call ci --source=.`.
  Nothing else. Same file copied into the real project (D1).
- Kit's own CI: the same workflow runs `ci` on `fixtures/dotnet-api/` for every push to
  this repo.
- **Done when:** a PR on the real project runs `ci`; a merge to `main` produces an image in
  GHCR whose `/health` reports the merged SHA. GitHub free minutes are enough for now; a
  self-hosted runner is a later, separate change.

### M5 — Server preparation · M · *blocked on hosting decision*

- `server/cloud-init.yaml`: non-root user, SSH keys only, password login off, ufw 22/80/443,
  fail2ban, unattended-upgrades, Docker.
- `kamal init` in the client repo; `config/deploy.yml` with the app, kamal-proxy TLS via
  Let's Encrypt, and Postgres as an accessory on a named volume (unless managed Postgres
  is chosen — then just the connection string).
- Secrets via `.kamal/secrets` reading from the CI secret store. A `docs/secrets.md` in the
  client repo listing *where* each secret lives — this is the part that rots first.
- Off-server backup: cron on the server → `pg_dump -Fc` → `rclone` to an S3-compatible
  bucket at a different provider. Retention 30 daily / 12 monthly.
- `docs/runbooks/restore.md`: step-by-step restore into a scratch database. **Executed
  once by hand and the date recorded in the runbook.**
- **Done when:** `kamal setup` brings the fixture up over HTTPS; the first nightly backup
  exists in the bucket; the restore drill is dated.

### M6 — `deploy` · L

- `backup` per D7. The verified dump's bucket path is the gate token: `migrate` refuses to
  run unless it receives one.
- `migrate`: read last applied from prod (D5) → build the bundle for `head` → run it.
  Failure stops the pipeline; the old image is still serving.
- `release`: `kamal deploy --version sha-<short>`.
- `verify`: GET `<url>/health` with retries for up to N seconds; passes only when
  `version == sha-<short>`. A 200 from the previous container is a failure.
- `rollback`: on `verify` failure, `kamal rollback <previous sha>`. Database is **not**
  rolled back (roll forward); the run ends red with the backup path printed.
- `clean`: `kamal prune`.
- `--plan` / `--yes` per D3.
- **Done when, on the fixture in production:** a deliberately failing migration → deploy
  stops, old version still serving, no new container; a deliberately broken `/health` →
  release happens, `verify` fails, rollback fires, old version serving again; a normal
  change → new SHA served over HTTPS. Each of the three runs is recorded in
  `docs/runbooks/deploy-scenarios.md` with the command, the output, and the date.

### M7 — Monitoring, runbooks, tag · S

- Uptime Kuma on infrastructure that is not the monitored server, watching the public URL
  and `/health`.
- Runbooks: deploy, rollback, restore, rotate a secret, add a migration safely.
- `CLAUDE.md` snippet for client repos (the .NET rules, verbatim from §12 of the plan).
- Tag `v1.0.0`. From here, changes to the core need a fixture scenario that fails without
  them.

---

## Order and dependencies

```
M0 → M1 → M2 → M3 → M4 ─┐
                         ├→ M6 → M7
      (hosting decided) → M5 ─┘
```

M0–M4 need no decision that is still open and no server. M5 is the only milestone waiting
on a decision, and M6 needs M5. If hosting is decided early, M5 can run in parallel with M3.

## Known traps to watch for while building

- Dagger's TypeScript SDK caches by input; a `Directory` that includes `bin/` and `obj/`
  busts the cache every run. Exclude them at the `--source` boundary.
- `dotnet ef migrations script` needs the *startup* project and the *migrations* project;
  in a multi-project solution they differ. Both come from `shipkit.yaml`, never guessed.
- The migration bundle must be built `--self-contained -r linux-x64` or it will not run on
  a server without the SDK.
- `kamal deploy` reads the image tag from `config/deploy.yml`; the core passes
  `--version`, it does not edit the file.
- Squawk's exit code is non-zero on warnings as well as errors. That is what we want;
  do not add `--assume-in-transaction` or rule suppressions in the core.
