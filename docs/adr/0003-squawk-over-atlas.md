# 0003 — Squawk, not Atlas, lints migrations

Status: accepted · 2026-09-11

## Context

The `db` stage must reject dangerous DDL before it reaches `main`: non-concurrent index
creation, destructive column operations, locking type changes. With one repo per client,
per-project licence costs multiply.

## Decision

**Squawk** (Rust, open source, ~32 PostgreSQL rules) lints the generated migration SQL.
**EF Core migration bundles** apply it.

## Alternatives rejected

- **Atlas** — since v0.38 (Oct 2025) `atlas migrate lint` requires Pro: roughly
  $9/developer/month **plus ~$59 per CI project/month**. One repo per client multiplies
  that. The Community Edition is Apache 2.0, but official sources contradict each other on
  whether `migrate lint` is included — the release notes say the lint code stays in CE, the
  CE docs page lists `migrate lint` as unsupported. The free "Hacker License" explicitly
  excludes commercial use, which client work is. Verify against the community binary before
  relying on it. Squawk covers the actual risk for free.
- **Liquibase** — moved to FSL in Oct 2025, which is not an OSI licence.
- **Flyway** — a migration runner, not a linter. Redundant next to EF Core.

## Consequences

- Squawk parses SQL, so it must be pointed at the **non-idempotent** script. **Measured
  2026-09-12** on one migration dropping a populated column: the non-idempotent script
  produced 3 findings including `ban-drop-column`; the `--idempotent` form of the same
  migration, with statements wrapped in `DO $EF$ ... END $EF$`, produced **zero**. Squawk does
  not look inside `DO` blocks, so linting the idempotent script would report a clean bill of
  health for a migration that destroys data. See `docs/runbooks/m3-db-gate-scenarios.md` and
  [0005](0005-migrations-never-at-startup.md).
- The rule set is configured in `.dagger/squawk.default.toml`, which a client repo overrides
  with its own `.squawk.toml`. Every exclusion is written down with its reason: a gate that is
  red on every migration gets waived, and a waived gate is not a gate. `require-lock-timeout`
  and `require-statement-timeout` are excluded only because EF sets neither — the protection
  moves to the connection in the `migrate` stage (M6).
- Squawk's rule set is PostgreSQL-specific. Another database would need this ADR revisited.
