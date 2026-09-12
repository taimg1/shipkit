<!--
Installed into a client repository by `shipkit init` (append to its CLAUDE.md).

Only enforceable rules belong here. Long instruction files consume context and get followed
less; the reasoning lives in the shipkit repo's docs/adr/ and is read on demand.
-->

## Pipeline

- Run the pipeline with `shipkit ci`. Pipeline logic lives in the Dagger module, never in
  workflow YAML.
- Deploy only via `shipkit deploy`. Never by hand, never from YAML.
- **Never pass `--yes` without the user approving that exact plan in this conversation.**
  Run `shipkit deploy --plan`, show what it prints, wait for a yes, then pass the token.
  The token proves the plan was displayed; it does not prove anyone agreed to it.
- Tag images with the commit SHA. Never `latest`.

## Database

- Never call `Database.Migrate()` at application startup, and never run migrations from a
  container entrypoint. The pipeline applies them via `dotnet ef migrations bundle`.
- `dotnet ef migrations add` does not rebuild. Run `dotnet build` before `shipkit db lint`,
  or the script will be generated from a stale assembly and gate nothing.
- Every migration must pass Squawk before merge. Lint the non-idempotent script; apply the
  bundle. Squawk does not see inside `DO $$` blocks, so linting the idempotent form reports
  a clean bill of health for a migration that destroys data.
- Create indexes with `CONCURRENTLY` via
  `migrationBuilder.Sql(..., suppressTransaction: true)`.
- Destructive schema changes are split across releases (expand/contract). Never in one.
- An intentional loss is declared in the migration and names its target:
  `-- shipkit:allow-loss <table>.<column>  <reason>`. It waives that one loss and nothing else.
- Never write `Down` migrations for production recovery. Roll forward.
- Database tests run against a real PostgreSQL via Testcontainers. Never mock the DbContext.
- Keep `ci/seed.sql` covering every table. It is what proves a migration did not eat rows.

## The health contract

- `/health` returns `{"status":"ok","version":"<commit sha>"}` and touches no dependency.
  `verify` compares that version against the SHA it just deployed — a 200 carrying the
  previous version is a failed deploy that looks green.
- `/health/ready` checks the database and returns 503 when it cannot be reached. This is the
  one monitoring watches; `/health` answers 200 with the schema dropped.

## Gates

Every gate fails closed. A step that logs a warning and continues is not a gate, and a rule
that gets waived on every migration is not a rule — change the rule or fix the code, do not
add an exclusion.
