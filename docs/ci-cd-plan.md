# CI/CD Plan — .NET + EF Core + PostgreSQL on a Bare Server

> **What this document is:** a planning and handoff document, not a `CLAUDE.md`.
> It records decisions, the reasoning behind them, and the traps that motivated
> those decisions. See [§12](#12-what-belongs-in-claudemd) for the short list of
> rules that should be extracted into `CLAUDE.md`.

---

## 1. Context and constraints

| Constraint | Detail |
|---|---|
| Backend | .NET, EF Core, PostgreSQL |
| Frontend | React — likely a static host (Cloudflare Pages / Vercel), separate from the backend |
| Repos | Private GitHub. A **separate GitHub account is created per client**, on the client's email |
| QA stage | **None.** Changes go from `main` straight to production |
| Project type | Turnkey client projects, delivered and then maintained |
| Coupling | GitHub is the current host, but the pipeline must not be welded to it |
| Interface | Must be runnable by a human from a terminal **and** callable programmatically by another application |
| Budget | Free / open-source wherever possible |

**The goal is not "automate deploys."** The goal is: when a change is made,
something independent verifies that nothing breaks, that migrations apply safely,
and that production can be returned to a known-good state quickly.

---

## 2. Architecture principle: three separate layers

The single most important structural decision. Keep these apart:

1. **Pipeline logic** — what actually runs (lint, build, test, migrate, deploy).
   Lives in the repository, written as code.
2. **Trigger** — who starts it. Currently GitHub Actions.
3. **Delivery** — how the artifact reaches the server. Kamal.

**Rule: the CI YAML file contains a checkout and one call. Nothing else.**

Lock-in only ever appears when layer 1 leaks into layer 2. As long as the
workflow file is a thin wrapper, migrating to Woodpecker, Gitea Actions, or
GitLab CI means rewriting ~10 lines instead of rewriting the pipeline.

---

## 3. Tool selection and cost

| Layer | Tool | Licence / cost |
|---|---|---|
| Pipeline logic | **Dagger** (TypeScript SDK) | Apache 2.0, free (Dagger Cloud is paid, not required) |
| Trigger | **GitHub Actions** | Free minutes per month on private repos; a self-hosted runner removes the limit entirely |
| Container build | Docker / `dotnet publish` | Free |
| Image registry | GHCR | Free within limits |
| Integration tests | **Testcontainers for .NET** | Free (Testcontainers Cloud is paid, not required) |
| Migration linting | **Squawk** | Free, open source. Rust, ~32 PostgreSQL rules |
| Migration execution | **EF Core migration bundle** | Part of .NET |
| Deploy | **Kamal** | MIT, free |
| Server provisioning | cloud-init (+ Ansible if it grows) | Free |
| Infrastructure as code | **OpenTofu** — *deferred, see §10* | MPL-2.0, free |
| Uptime monitoring | **Uptime Kuma** (self-hosted) | MIT, free |

### Tools deliberately rejected

- **Atlas** — since v0.38 (Oct 2025) `atlas migrate lint` requires Pro:
  ~$9/developer/month **plus ~$59 per CI project/month**. With one repo per
  client that multiplies. The Community Edition is Apache 2.0, but official
  sources contradict each other on whether `migrate lint` is included — the
  release notes say the lint code stays in CE, the CE docs page lists
  `migrate lint` as unsupported. The free "Hacker License" explicitly excludes
  commercial use. Verify against the community binary before relying on it.
  Squawk covers the actual risk for free.
- **Liquibase** — moved to FSL in Oct 2025, which is not an OSI licence.
- **Flyway** — a migration runner, not a linter. Redundant next to EF Core.
- **Terraform** — BUSL, owned by IBM. OpenTofu is the drop-in alternative.
- **Jenkins** — JVM + plugin architecture; poor fit for container-first pipelines.
- **Drone** — licence restrictions after acquisition; Woodpecker is the fork to use.
- **A custom TUI for pipeline output** — Dagger already reports per-step timings.
  Writing a pretty progress renderer is the *easy* part of CI and provides none
  of the value (isolated, reproducible execution on every push).

---

## 4. Pipeline `ci` — runs on every push and pull request

| Stage | What it does | Fails the build when |
|---|---|---|
| `pre` | `dotnet restore`, `dotnet format --verify-no-changes`, analyzers | Formatting drift or analyzer errors |
| `build` | `dotnet publish` → Docker image | Compilation error |
| `test` | Unit tests + integration tests against a **real PostgreSQL** via Testcontainers | Any test fails |
| `db` | Generate SQL diff of new migrations → lint with Squawk → apply to a schema copy | Squawk reports a violation, or migrations fail to apply |
| `push` | Push image to GHCR, tagged with the commit SHA | Only runs on `main` |

Notes:

- Integration tests against a real Postgres are not optional here. For a
  database-heavy application, unit tests with mocked repositories prove almost
  nothing about whether a change is safe.
- Tag images with the commit SHA, never `latest`. Rollback needs an addressable
  artifact.

---

## 5. Pipeline `deploy` — runs on merge to `main` or manually

| Stage | What it does |
|---|---|
| `backup` | `pg_dump` of production; **verify the dump is non-empty and restorable** |
| `migrate` | Apply the EF migration bundle to production |
| `release` | `kamal deploy` — zero-downtime container swap |
| `verify` | Smoke test against the live URL |
| `rollback` | Automatic if `verify` fails |
| `clean` | Prune old images |

### Confirmation behaviour

`deploy` without `--yes` prints what is about to happen — target environment,
image version, the list of migrations that will be applied, and the SQL diff —
and waits for confirmation. With `--yes` it proceeds unattended.

This is the deliberate replacement for a "Deploy to production?" prompt in a
manual script: the same information, but the decision is optional rather than
required, and an automated caller can skip it.

---

## 6. Gates replace the missing QA stage

With no manual QA, nothing catches a bad change unless an automated gate stops
it. These are the gates, in order of when they fire:

1. **Squawk red → the merge is blocked.** A dangerous migration never reaches `main`.
2. **Backup missing, empty, or unverified → the migration does not run.**
3. **Migration fails → the deploy stops before the new image goes live.**
4. **Smoke test red → automatic rollback.**

Every one of these must fail *closed*. A gate that fails open (for example, a
backup step that logs a warning and continues) is worse than no gate, because
it produces the appearance of safety.

---

## 7. Migrations — the actually dangerous part

This is where a database-heavy project gets hurt, not in the build.

### 7.1 Never migrate on application startup

Do not call `Database.Migrate()` in `Program.cs`. Reasons:

- With more than one instance, two processes race to apply the same migration.
- The application needs DDL privileges at runtime, permanently.
- There is no opportunity to inspect what is about to be applied.
- A failed migration fails at boot, in front of users, with no rollback path.

Use `dotnet ef migrations bundle` instead — a self-contained executable built in
CI that needs neither the SDK nor the source on the target machine. Alternatively
`dotnet ef migrations script --idempotent` produces plain SQL.

### 7.2 Lint the non-idempotent script, apply the idempotent one

`--idempotent` wraps every statement in `DO $$ ... $$` PL/pgSQL blocks. Squawk
parses SQL and may not analyse statements nested inside those blocks — which
would produce a **false green**.

Therefore:

- Generate a plain (non-idempotent) script for **linting**.
- Generate the bundle or idempotent script for **applying**.
- **Verify this behaviour on the very first migration** before trusting the gate.

Generate the diff relative to what is actually deployed:

```
dotnet ef migrations script <last-deployed-migration> <head> --output ci/migration.sql
```

This requires storing the last deployed migration id somewhere durable
(deployment metadata, or read it back from the production `__EFMigrationsHistory`
table during the deploy step).

### 7.3 The EF Core rename trap

Renaming a property in a model frequently generates `DROP COLUMN` + `ADD COLUMN`
rather than `RENAME COLUMN`. The migration succeeds, CI is green, and the data in
that column is silently gone. This is the single most likely way to lose client
data with this stack.

Mitigations, in order of strength:

1. A Testcontainers test that restores a schema copy **with seed rows**, applies
   the new migrations, and asserts row and column counts.
2. Squawk's destructive-operation rules.
3. As a crude backstop, grep the generated SQL for `DROP COLUMN` / `DROP TABLE`
   and fail the build unless the migration is explicitly annotated as intentional.

### 7.4 Index creation locks the table

EF generates a plain `CREATE INDEX`, which blocks writes for the duration. On an
empty client database that is instant; on a table with a year of data it is
minutes of downtime while the pipeline reports success.

`CONCURRENTLY` must be written manually:

```csharp
migrationBuilder.Sql(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_created_at ON orders (created_at);",
    suppressTransaction: true);
```

`suppressTransaction: true` is required — `CREATE INDEX CONCURRENTLY` cannot run
inside a transaction, and EF wraps migrations in one by default.

Squawk flags the non-concurrent form, which is a large part of why it is in the
pipeline at all.

### 7.5 Other PostgreSQL hazards worth knowing

- `ALTER COLUMN ... TYPE` rewrites the entire table under an exclusive lock.
- Adding a column with a volatile default rewrites the table on older PostgreSQL versions.
- `SET NOT NULL` on an existing column requires a full table scan under a lock.
- Adding a foreign key or unique constraint without `NOT VALID` + `VALIDATE` locks both tables.

### 7.6 Expand / contract

Zero-downtime deployment means the old and new application versions run
simultaneously for a few seconds. The schema must therefore be compatible with
**both**. Split destructive changes across two releases:

1. Release N: add the new column, write to both, read from the old.
2. Release N+1: read from the new, stop writing the old.
3. Release N+2: drop the old column.

### 7.7 Roll forward, not back

Do not rely on EF `Down` migrations in production. If a migration is wrong, ship
a new migration that corrects it. `Down` is for local development.
Application rollback (Kamal) and database rollback are separate concerns — this
is exactly why the verified backup in §5 exists.

---

## 8. One-time server preparation

Executed once per server, before any pipeline runs.

- **cloud-init**: non-root user, SSH key authentication only, password login
  disabled, firewall (allow 22/80/443 only), fail2ban, unattended security
  upgrades, Docker installed.
- **`kamal setup`** — bootstraps the application on a bare host.
- **PostgreSQL** in a container with a named volume, or the provider's managed
  PostgreSQL service. Do not put the database on an ephemeral filesystem.
- **TLS** via kamal-proxy with Let's Encrypt.
- **Backups**: scheduled `pg_dump`, copied **off the server** (different provider
  or different country). A backup that lives only on the machine it backs up is
  not a backup.
- **Restore drill**: restore from a backup into a scratch database at least once,
  manually, before the first client goes live. Until a restore has actually been
  performed, the backup strategy is unverified.
- **Uptime Kuma** on separate infrastructure, monitoring the public URL.
  Monitoring that runs on the monitored server tells you nothing when it matters.

### Secrets

- Never committed. Injected via Kamal secrets / CI secret store.
- Per-client GitHub accounts mean per-client secret stores. Document where each
  project's secrets live; this is the part that rots first.

---

## 9. Rollout order

Each step delivers value on its own and does not require the next one.

1. `Dockerfile` + `docker-compose.yml` (app + Postgres) for local development.
2. Dagger module: `ci` with `pre`, `build`, `test`. **Works today, independent of
   any hosting decision.**
3. Add the `db` stage: script generation, Squawk, apply-to-copy.
4. Thin GitHub Actions workflow that calls `dagger call ci`.
5. Server preparation (§8) once the host is chosen.
6. `deploy` with backup → migrate → release → verify → rollback.
7. Uptime monitoring.
8. Only after two or three real projects: extract the shared parts into a
   reusable kit.

**Do not design the generic multi-project utility first.** Build it concretely
twice; the differences between those two implementations are what define the
utility's parameters. Designing it up front means designing against imagined
requirements.

---

## 10. Deferred: infrastructure as code

OpenTofu (not Terraform) — but not yet, and for a specific reason:

- It is **not a monitoring tool**. It tracks the desired state of infrastructure
  and detects configuration drift via `plan`. Server health is Uptime Kuma's job.
- It only manages resources it created or that were explicitly imported. Pointing
  it at a hand-built server shows nothing.
- It is provider-specific. The code for Hetzner, DigitalOcean, and a local
  Ukrainian host have nothing in common beyond HCL syntax. **It cannot be written
  before the hosting decision is made.**
- Small local hosting providers often have no OpenTofu provider at all, even when
  they expose a full REST API. In that case the layer becomes scripts, not IaC.
- The state file contains database passwords and keys in plain text. OpenTofu
  supports client-side state encryption; Terraform does not. With one state file
  per client this matters.

It pays off when several clients share an identical stack: one module plus a
variables file per client. Not before.

---

## 11. Variants (recorded for completeness)

The `ci` stage is identical in all three. Only delivery differs.

| | **A — bare server** | **B — PaaS** | **B1 — PaaS, quick** |
|---|---|---|---|
| Pipeline logic | Dagger | Dagger | Plain GitHub Actions YAML |
| Runs locally | Yes | Yes | No (only partially, via `act`) |
| Callable from another app | Yes | Yes | No |
| Delivery | Kamal | Platform's own deploy | Platform's own deploy |
| Server prep | Required (§8) | None | None |
| Monthly cost | Fixed, per server | Per service, per client | Per service, per client |
| Use when | Projects you maintain | Backend already on a PaaS | One-off handover projects |

**Do not run two delivery models at the same time.** Supporting both means doing
every operational task twice per client.

If B1 is used, do not write it from scratch — keep the commands in one place
(scripts or a `Taskfile`) and have both the YAML and the Dagger module call the
same commands. Otherwise the two definitions drift apart within months.

### PaaS notes (if that route is ever taken)

- Free tiers are not viable for client work: services that sleep after ~15
  minutes of inactivity wake in roughly a minute, and free PostgreSQL instances
  are typically size-capped and time-limited, with deletion after the window
  expires and no backups.
- Static-host free tiers frequently prohibit commercial use, which includes work
  done for a paying client. Check the terms before putting a client on one.

---

## 12. What belongs in `CLAUDE.md`

Extract only enforceable rules. Keep it short — long instruction files consume
context and reduce adherence. Everything else stays in this document and in ADRs.

```markdown
- Never call Database.Migrate() at application startup.
  Migrations are applied by the pipeline via `dotnet ef migrations bundle`.
- Every new migration must pass Squawk before merge.
  Lint the non-idempotent script; apply the bundle.
- Database tests use Testcontainers with a real PostgreSQL. Never mock the DbContext.
- Create indexes with CONCURRENTLY via migrationBuilder.Sql(..., suppressTransaction: true).
- Destructive schema changes are split across releases (expand/contract). Never in one.
- Never write Down migrations for production recovery. Roll forward.
- Deploy only via `dagger call deploy`. Never by hand, never from YAML.
- Tag images with the commit SHA. Never `latest`.
- Pipeline logic lives in the Dagger module, never in workflow YAML.
```

Decisions and rationale (why Squawk over Atlas, why a bare server over PaaS,
why IaC is deferred) belong in `docs/adr/`, read on demand rather than every
session.

---

## 13. Open questions

- [ ] Final hosting target for the backend (bare VPS vs. existing PaaS).
- [ ] Frontend host, and whether its free tier permits commercial use.
- [ ] Managed PostgreSQL vs. self-hosted container — decides who owns backups.
- [ ] One server shared across small clients vs. one server per client
      (isolation and blast radius vs. cost).
- [ ] Where the last-deployed-migration marker is stored.
- [ ] Self-hosted GitHub Actions runner: on the existing Proxmox host or elsewhere.
