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

- Squawk parses SQL, so it must be pointed at the **non-idempotent** script. The
  `--idempotent` form wraps statements in `DO $$ ... $$` PL/pgSQL blocks that Squawk may not
  analyse, producing a false green. See [0005](0005-migrations-never-at-startup.md).
- Squawk's rule set is PostgreSQL-specific. Another database would need this ADR revisited.
