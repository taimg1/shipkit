# 0004 — Four fail-closed gates replace the missing QA stage

Status: accepted · 2026-09-11

## Context

There is no QA stage. Changes go from `main` straight to production. Nothing catches a bad
change unless an automated gate stops it.

## Decision

Four gates, in firing order:

1. **Squawk red → the merge is blocked.** A dangerous migration never reaches `main`.
2. **Backup missing, empty or unverified → the migration does not run.**
3. **Migration fails → the deploy stops before the new image goes live.**
4. **Smoke test red → automatic rollback.**

Every one fails **closed**.

Supporting rules:

- Integration tests run against a real PostgreSQL via Testcontainers. For a database-heavy
  application, unit tests with mocked repositories prove almost nothing about safety.
- Images are tagged with the commit SHA, never `latest` — rollback needs an addressable
  artifact.
- Backups are copied off the server (different provider or country), and a manual restore
  drill happens before the first client goes live. Until a restore has been performed, the
  backup strategy is unverified.
- Uptime monitoring (Uptime Kuma) runs on separate infrastructure. Monitoring that runs on
  the monitored server tells you nothing when it matters.

## Consequences

- A gate that fails open — a backup step that logs a warning and continues — is worse than
  no gate, because it manufactures the appearance of safety. Such a step is a bug.
- `deploy` without `--yes` prints target environment, image version, pending migrations and
  the SQL diff, then waits. With `--yes` it proceeds unattended, so an automated caller is
  not blocked. The decision is optional rather than required.
