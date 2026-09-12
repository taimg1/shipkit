# shipkit

CI/CD toolkit for turnkey .NET + EF Core + PostgreSQL client projects.
Pipeline logic is a Dagger module; GitHub Actions only triggers it; Kamal delivers.

Full rationale: `docs/ci-cd-plan.md`. Decisions: `docs/adr/`. Read those on demand,
not every session.

## Rules

- Never call `Database.Migrate()` at application startup.
  Migrations are applied by the pipeline via `dotnet ef migrations bundle`.
- Every new migration must pass Squawk before merge.
  Lint the non-idempotent script; apply the bundle.
- Database tests use Testcontainers with a real PostgreSQL. Never mock the DbContext.
- Create indexes with `CONCURRENTLY` via `migrationBuilder.Sql(..., suppressTransaction: true)`.
- Destructive schema changes are split across releases (expand/contract). Never in one.
- Never write `Down` migrations for production recovery. Roll forward.
- Deploy only via `dagger call deploy`. Never by hand, never from YAML.
- Tag images with the commit SHA. Never `latest`.
- Pipeline logic lives in the Dagger module, never in workflow YAML.
- Every gate fails closed. A step that logs a warning and continues is not a gate.
