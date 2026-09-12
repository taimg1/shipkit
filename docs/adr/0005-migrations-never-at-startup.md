# 0005 — Migrations are applied by the pipeline, never at application startup

Status: accepted · 2026-09-11

## Context

Migrations are where a database-heavy project gets hurt, not the build.

## Decision

Never call `Database.Migrate()` in `Program.cs`. The pipeline applies migrations using
`dotnet ef migrations bundle` — a self-contained executable built in CI that needs neither
the SDK nor the source on the target machine.

## Rationale

- With more than one instance, two processes race to apply the same migration.
- The application would need DDL privileges at runtime, permanently.
- There is no opportunity to inspect what is about to be applied.
- A failed migration fails at boot, in front of users, with no rollback path.

## Rules that follow

- **Lint the non-idempotent script, apply the idempotent one / the bundle.** Verify this
  behaviour on the very first migration before trusting the gate. See [0003](0003-squawk-over-atlas.md).
- **Diff against what is actually deployed:**
  `dotnet ef migrations script <last-deployed-migration> <head> --output ci/migration.sql`.
  This requires storing the last deployed migration id durably — deployment metadata, or
  read back from production `__EFMigrationsHistory` during deploy. Where it is stored is
  still open.
- **The EF rename trap.** Renaming a property frequently generates `DROP COLUMN` + `ADD COLUMN`
  rather than `RENAME COLUMN`. The migration succeeds, CI is green, and the column's data is
  silently gone. This is the single most likely way to lose client data with this stack.
  Mitigations in order of strength: a Testcontainers test that restores a schema copy **with
  seed rows**, applies the new migrations and asserts row and column counts; Squawk's
  destructive-operation rules; a grep of the generated SQL for `DROP COLUMN` / `DROP TABLE`
  that fails the build unless explicitly annotated as intentional.
- **Indexes lock the table.** EF emits a plain `CREATE INDEX`, which blocks writes for its
  duration — instant on an empty client database, minutes of downtime on a table with a year
  of data, while the pipeline reports success. Write it manually:

  ```csharp
  migrationBuilder.Sql(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_created_at ON orders (created_at);",
      suppressTransaction: true);
  ```

  `suppressTransaction: true` is required — `CREATE INDEX CONCURRENTLY` cannot run inside a
  transaction, and EF wraps migrations in one by default.
- **Other PostgreSQL hazards:** `ALTER COLUMN ... TYPE` rewrites the whole table under an
  exclusive lock; adding a column with a volatile default rewrites the table on older
  PostgreSQL; `SET NOT NULL` on an existing column needs a full scan under a lock; adding a
  foreign key or unique constraint without `NOT VALID` + `VALIDATE` locks both tables.
- **Expand / contract.** Zero-downtime deployment means old and new application versions run
  simultaneously for a few seconds, so the schema must be compatible with both. Split
  destructive changes: release N adds the new column and writes to both while reading the old;
  N+1 reads the new and stops writing the old; N+2 drops the old column.
- **Roll forward, not back.** Do not rely on EF `Down` migrations in production; ship a new
  migration that corrects the wrong one. `Down` is for local development. Application rollback
  (Kamal) and database rollback are separate concerns — which is exactly why the verified
  backup in [0004](0004-automated-gates-replace-qa.md) exists.
