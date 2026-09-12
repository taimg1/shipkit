# Multi-stack plan — one kit for .NET, NestJS and Next.js

> Companion to `ci-cd-plan.md`. That document was written for .NET + EF Core + PostgreSQL.
> This one says what stays the same when the stack changes, what varies, where the seam
> between them is, and in what order to build it so the kit is not designed against
> imagined requirements.

---

## 1. What the kit must not depend on

| Dependency | Risk | Position |
|---|---|---|
| GitHub | Client repos may move to Gitea / GitLab / self-hosted | Already mitigated by the thin-YAML rule (ADR 0001) |
| The application stack (.NET / Nest / Next) | Locks the kit to one language and one ORM | **This document.** Isolate behind a stack adapter |
| The ORM's migration format | Determines how a SQL diff is produced and how it is applied | Adapter concern; the kit only sees plain SQL + an "apply" step |
| Dagger | It *is* the pipeline runner | Accepted. Apache 2.0; the stage logic is shell commands inside containers, which is portable by nature. Do not wrap it |
| Kamal | It *is* the delivery layer | Accepted. It consumes a Docker image and nothing else, so it is replaceable per project without touching `ci` |
| PostgreSQL | Squawk is PostgreSQL-only | Accepted. A MySQL client would need a different linter, not a different kit |
| Docker | Universal artifact format | Accepted, deliberately |

Rule of thumb: **abstract what varies between clients; do not abstract what varies only
between imaginary futures.** Dagger, Kamal, Postgres and Docker are fixed. The stack is not.

---

## 2. Universal vs. stack-specific

The pipeline shape is universal. The *content* of four stages is not.

| Stage | Universal | Stack-specific |
|---|---|---|
| `pre` | "fail on formatting drift or analyzer errors" | `dotnet format --verify-no-changes` vs. `prettier --check` + `eslint` (or `biome ci`) |
| `build` | "produce an image tagged with the commit SHA" | The `Dockerfile` — multi-stage, per stack |
| `test` | "run tests against a real PostgreSQL via Testcontainers; any failure fails the build" | `dotnet test` vs. `vitest` / `jest`; `@testcontainers/postgresql` vs. `Testcontainers.PostgreSql` |
| `db` | "produce a plain SQL diff of pending migrations → Squawk → apply to a schema copy" | How the diff is generated and how it is applied (see §4) |
| `push` | GHCR, SHA tag, `main` only | — |
| `backup` | `pg_dump`, verify non-empty and restorable | — |
| `migrate` | "apply the pending migrations artifact to production" | The artifact: EF bundle vs. `prisma migrate deploy` vs. `drizzle-kit migrate` |
| `release` | `kamal deploy` | — |
| `verify` | HTTP smoke test against the live URL | — (see §5 for the health-endpoint convention) |
| `rollback` | automatic on `verify` failure | — |
| `clean` | prune old images | — |
| gates | all four, all fail closed (ADR 0004) | — |
| `--yes` behaviour | identical | — |
| server prep, backups, monitoring, secrets | identical (ADR 0006) | — |

Everything in the "universal" column is written **once**, in the kit core.
Everything in the "stack-specific" column is a **stack adapter**.

---

## 3. The seam: stack adapters

One TypeScript interface inside the Dagger module. Each stack implements it. The core
never branches on stack name — it only calls the interface.

```ts
interface StackAdapter {
  readonly name: "dotnet" | "nest" | "next" | "custom";

  /** Restore dependencies with a cache mount. Returns a container ready for lint/test. */
  restore(src: Directory): Container;

  /** Fails the container if formatting drifts or analyzers report errors. */
  lint(c: Container): Container;

  /** Produces the production image. Owns the Dockerfile. */
  build(src: Directory): Container;

  /** Runs unit + integration tests. `postgres` is a Testcontainers-style service the core provides. */
  test(c: Container, services: { postgres?: Service }): Container;

  /** Absent for stacks with no database (e.g. a static Next.js site). */
  db?: DbAdapter;

  /** Path the smoke test hits. Default "/health". */
  healthPath: string;
}

interface DbAdapter {
  /** Name of the migration history table, e.g. "__EFMigrationsHistory", "_prisma_migrations". */
  historyTable: string;

  /** Reads the last applied migration id from a live database. */
  lastApplied(db: Service | string): Promise<string | null>;

  /**
   * Plain, NON-idempotent SQL for everything after `lastApplied`.
   * This is what Squawk lints. Must not be wrapped in DO $$ blocks.
   */
  pendingSql(src: Directory, lastApplied: string | null): File;

  /** The thing that actually applies migrations in production: a bundle, or a container + command. */
  applyArtifact(src: Directory): File | Container;
}
```

Configuration lives in the **client repo**, not the kit:

```yaml
# shipkit.yaml
stack: nest            # dotnet | nest | next | custom
db: postgres           # postgres | none
delivery: kamal        # kamal | static
health: /health
```

### The `custom` adapter — the escape hatch

`custom` delegates each method to a Taskfile target in the client repo (`task lint`,
`task build`, `task test`, `task db:pending-sql`, `task db:apply`). It exists so that a
stack the kit does not know (Go, Django, TypeORM…) can still ride the universal core
without forking it. It is deliberately the *worst* option — every target is one more thing
that drifts per client — so the three named adapters should cover everything actually used.

### What the adapter does NOT own

- Gate logic. An adapter cannot decide to continue on a failed backup.
- Tagging. The core tags; the adapter only builds.
- Confirmation. The `--yes` flow is core.
- Delivery. Kamal consumes whatever `build()` returned.

If an adapter ever needs to own one of these, the seam is in the wrong place — stop and
revisit ADR 0008 instead of adding a flag.

---

## 4. The database seam, per stack

The `db` stage is the only part of `ci` where the stacks differ *materially*, and it is
the part that loses client data if it is wrong. Each adapter must answer the same four
questions.

| | .NET / EF Core | NestJS / Prisma | NestJS / Drizzle | Next.js |
|---|---|---|---|---|
| History table | `__EFMigrationsHistory` | `_prisma_migrations` | `__drizzle_migrations` (in `drizzle` schema) | none by default; if full-stack, same as Prisma/Drizzle |
| Pending SQL for Squawk | `dotnet ef migrations script <last> <head>` — **non**-idempotent | `prisma migrate diff --from-migrations … --to-schema-datamodel … --script`, or simply the `migrations/*/migration.sql` files newer than `<last>` — already plain SQL | `drizzle-kit generate` emits `.sql` files — already plain SQL | — |
| Apply artifact | `dotnet ef migrations bundle` — self-contained executable | app image + `prisma migrate deploy` | app image + `drizzle-kit migrate` | — |
| "Migrate on startup" anti-pattern looks like | `Database.Migrate()` in `Program.cs` | `prisma migrate deploy` in the container `CMD` / entrypoint | `migrate()` call in `main.ts` | — |

Notes:

- **Prisma and Drizzle are easier than EF here**, not harder: their migrations are already
  plain SQL files on disk, so the false-green problem from the idempotent wrapper
  (`ci-cd-plan.md` §7.2) does not exist. Squawk lints the files directly.
- **TypeORM and MikroORM are not first-class.** Their generated migrations are TypeScript
  with SQL embedded in strings. Linting that means either running the migration against a
  scratch database with query logging and linting the log, or extracting strings. Both are
  fragile. New Nest projects should standardise on Prisma or Drizzle; an existing TypeORM
  project uses the `custom` adapter and accepts a weaker gate.
- **The rename trap generalises.** Prisma emits `DROP COLUMN` + `ADD COLUMN` on a field
  rename exactly like EF does. The seeded-schema-copy test with row/column-count assertions
  (§7.3) is core, not adapter — it works on any stack's SQL.
- **`CREATE INDEX CONCURRENTLY`** is written by hand in every stack. Prisma cannot emit it;
  edit the generated `migration.sql`. Drizzle: `.concurrently()` on the index builder, and
  the migration must run outside a transaction (`breakpoints` / manual). Squawk catches the
  non-concurrent form regardless of who wrote it.

---

## 5. Conventions every client project must follow

These are the price of the universal core. They are small, and they are what makes
`verify` and `migrate` stack-agnostic.

1. **`/health` returns 200 and the running commit SHA** (`{"status":"ok","version":"<sha>"}`).
   The smoke test does not just check for 200 — it checks that the SHA it just deployed is
   the one answering. A 200 from the *old* container is a failed deploy that looks green.
2. **The Dockerfile lives in the client repo** under a fixed path. The kit builds it; it does
   not template it. Templates for the three stacks live in `templates/` in this repo and are
   copied once at project setup, then owned by the project.
3. **No migration runs from the container entrypoint.** Ever. Any stack.
4. **`shipkit.yaml` at the repo root.** Missing file = build fails with a message, not a
   default. Defaults hide misconfiguration.
5. **One delivery model per project.** A Next.js SSR app goes to Kamal as a container, same
   as the backend. Static export to a static host is a separate `delivery: static` variant
   for genuinely static sites, and only after checking the host's commercial-use terms.

---

## 6. Next.js specifically

Next.js is the odd one out: it may have no database, and it may not need a server.

- **SSR / app router with a server** → `output: 'standalone'` in `next.config`, multi-stage
  Dockerfile, deployed by Kamal behind kamal-proxy. `db: none`, so the `db`, `backup` and
  `migrate` stages are skipped *explicitly* — the core logs "skipped: db=none", it does not
  silently omit them.
- **Full-stack Next.js with Prisma/Drizzle** → the Nest DB adapter is reused as-is; nothing
  about it is Nest-specific.
- **Pure static** (`output: 'export'`) → `delivery: static`. `ci` runs unchanged; `deploy`
  becomes "upload the export". Free tiers of static hosts frequently forbid commercial use
  (`ci-cd-plan.md` §11) — this is the one place where a paid tier is likely unavoidable.
- `pre` for Next/Nest: `prettier --check` + `eslint --max-warnings 0`, or `biome ci` if the
  project uses Biome. Pick one per project in `shipkit.yaml`; the adapter does not guess.
- `test`: `vitest` for unit; Playwright for e2e is **out of scope for `ci`** — it belongs in
  `verify` against the live URL if at all, otherwise it doubles CI time for every push.

---

## 7. Build order

Same principle as `ci-cd-plan.md` §9: each step delivers value alone, and **the second
stack is the test of the seam, not a feature**.

| # | Step | What it proves |
|---|---|---|
| 0 | Write ADR 0008 and this document. **No code.** | The seam is stated before it is built, so step 3 has something to check against |
| 1 | `ci` for **.NET**: `pre`, `build`, `test`, `db`. Written directly, adapter interface present but with one implementation. Run against a real .NET project | The universal core works at all |
| 2 | `deploy` for .NET: backup → migrate → release → verify → rollback. Server prep (ADR 0006) | The gates work. This is where the first restore drill happens |
| 3 | **NestJS + Prisma adapter.** Expect the interface from §3 to be wrong in places. Fix the interface, not the adapter. **Do not start step 4 until the .NET adapter still passes after the refactor** | The DB seam is real. Two implementations define the interface |
| 4 | **Next.js adapter**, SSR variant first. `db: none` path | The "no database" and "skipped stage" paths are real |
| 5 | `delivery: static` variant for Next.js | The second delivery model, isolated to `deploy` |
| 6 | `custom` adapter + Taskfile contract | The escape hatch, written last, when it is known what it has to escape from |
| 7 | `templates/` for the three Dockerfiles and `shipkit.yaml`; `shipkit init <stack>` | Project setup is a copy, not a tutorial |
| 8 | Generalise `CLAUDE.md` in this repo and write the per-stack `CLAUDE.md` snippet that `shipkit init` drops into client repos | Rules follow the stack, not the kit |

Steps 1–2 are the original plan's steps 2–6 unchanged. Nothing in this document delays
them; it only fixes what the .NET code is *not* allowed to assume.

---

## 8. What the .NET adapter must not assume (checklist for step 1)

So that step 3 is a refactor and not a rewrite:

- [ ] No `dotnet` command outside the adapter file.
- [ ] The core never reads `__EFMigrationsHistory` by name — it calls `db.lastApplied()`.
- [ ] The core never knows the migration artifact is an executable — it receives `File | Container` and runs it.
- [ ] The Squawk step takes a `File` of SQL. It does not know who produced it.
- [ ] The Testcontainers Postgres service is started by the core and handed to `test()`. The adapter does not start its own.
- [ ] The health check reads `healthPath` from the adapter and `version` from the response body — nothing .NET-shaped.
- [ ] `shipkit.yaml` is parsed and validated in the core, before any adapter is chosen.

---

## 9. Proposed `CLAUDE.md` for this repo (apply at step 8, or now if preferred)

Stack-neutral versions of the current rules. The .NET-specific wording moves to the
`dotnet` snippet that `shipkit init` installs into client repos.

```markdown
- Migrations are applied by the pipeline (`dagger call deploy`), never at application
  startup and never from a container entrypoint. Any stack.
- Every migration must pass Squawk before merge. Squawk lints plain, non-idempotent SQL.
- Database tests run against a real PostgreSQL via Testcontainers. Never mock the data layer.
- Indexes are created CONCURRENTLY, outside a transaction, in every stack.
- Destructive schema changes are split across releases (expand/contract). Never in one.
- Never use "down" migrations for production recovery. Roll forward.
- Deploy only via `dagger call deploy`. Never by hand, never from YAML.
- Tag images with the commit SHA. Never `latest`.
- Pipeline logic lives in the Dagger module, never in workflow YAML.
- Every gate fails closed. A step that logs a warning and continues is not a gate.
- Stack-specific commands live in `adapters/<stack>.ts` only. The core never branches on stack name.
- `/health` returns the running commit SHA; `verify` checks it, not just the status code.
```

---

## 10. Open questions added by this document

- [ ] Which stack is actually first — .NET as planned, or whichever project is closest to
      needing this? The order in §7 assumes .NET; steps 3 and 4 swap freely.
- [ ] Prisma vs. Drizzle as the recommended ORM for new Nest projects. Both work; pick one to
      keep the template count down.
- [ ] Whether `shipkit.yaml` also carries Kamal's `config/deploy.yml` values, or whether the
      two stay separate files (leaning separate: Kamal's file is Kamal's).
- [ ] Monorepo (Next + Nest in one repo): one `shipkit.yaml` with two targets, or two files?
      Do not decide until there is such a repo.
