# dotnet-api — the fixture project

A minimal .NET 10 + EF Core + PostgreSQL API. It exists so the kit has something real to run
against: every stage from M2 onward is developed and tested here before it touches a client
repo.

It is deliberately small — one entity, one migration, one endpoint that matters — but it is
laid out the way a real client project is, with the startup project and the migrations
project separated. That separation is not decoration: it is the case `dotnet ef` handles
worst, so the kit must handle it from day one.

## Layout

```
src/Api               startup project — /health, DI, no migration code
src/Infrastructure    DbContext, the Order entity, Migrations/, design-time factory
tests/                integration tests against a real PostgreSQL
Dockerfile            multi-stage; SHA baked in at publish
docker-compose.yml    local development only
shipkit.yaml          what the kit reads
```

## Running it

```bash
# tests — starts PostgreSQL via Testcontainers
dotnet test

# the stack, with a known SHA
GIT_SHA=$(git rev-parse HEAD) docker compose up --build -d
curl localhost:8080/health          # {"status":"ok","version":"<sha>"}

# the schema is NOT created on startup, by design — apply it as the pipeline would
ConnectionStrings__Default="Host=localhost;Port=5432;Database=app;Username=postgres;Password=postgres" \
  dotnet ef database update --project src/Infrastructure --startup-project src/Api
curl localhost:8080/orders          # []
```

Until migrations are applied, `/orders` returns 500 while `/health` returns 200. That is the
correct behaviour, not a bug: nothing in this project applies migrations at startup.

## Deploying to dev-server

`.kamal/secrets` holds references, not passwords, and the kit refuses to deploy while any of
them has nothing behind it. For the simulated host, export throwaway values first:

```bash
export SHIPKIT_SSH_KEY=dev-server/.ssh/id_ed25519
export POSTGRES_PASSWORD=dev-only-owner-password
export APP_DB_PASSWORD=dev-only-app-password
# The application connects as `app`: rows in and out, no DDL.
export APP_DATABASE_URL="Host=shipkit-fixture-db;Port=5432;Database=app;Username=app;Password=$APP_DB_PASSWORD"
# The migration bundle connects as the owner, because migrations are DDL.
export SHIPKIT_DATABASE_URL="Host=shipkit-fixture-db;Port=5432;Database=app;Username=postgres;Password=$POSTGRES_PASSWORD"

shipkit deploy --plan
```

The `app` role is created by `config/postgres/create-app-role.sh`, which PostgreSQL runs when it
initialises an empty data directory — that is, when the deploy boots the database accessory
for the first time. Default privileges on the owner mean every table a migration creates is
readable and writable by `app` with no further grants.

A database that already existed before this script was added does not run it. Create the role
once, by hand, with the same grants plus the tables that already exist. `\password` prompts for
the password, so it never appears in a command line or shell history:

```bash
ssh -t deploy@HOST docker exec -it shipkit-fixture-db psql -U postgres -d app
```

```sql
CREATE ROLE app LOGIN;
\password app
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app;
```

## Constraints discovered while building it

Each of these cost a failed command, and each applies to any client project the kit runs on.

1. **The startup project must reference `Microsoft.EntityFrameworkCore.Design`**, not just
   the migrations project. Without it the tools refuse to run at all. It is referenced with
   `PrivateAssets=all` so it stays out of the runtime image.

2. **EF Core package versions must be pinned together.** `Npgsql.EntityFrameworkCore.PostgreSQL`
   resolved EF Core 10.0.4 while `Design` resolved 10.0.12, and the projects would not compile
   against each other. `Microsoft.EntityFrameworkCore` and `.Relational` are pinned explicitly.

3. **`dotnet ef migrations add` does not rebuild afterwards.** A subsequent `--no-build`
   command then reads an assembly that does not contain the new migration and emits an empty
   script — which every gate downstream would pass. The kit builds before generating a script
   and cross-checks the migration list against the SQL (`hasNoSchemaChange`), and this project
   is what that behaviour was found on.

4. **A design-time factory keeps SQL generation independent of a reachable database**, which
   is what the pipeline needs — but it must still honour `ConnectionStrings__Default` so the
   local `database update` loop works. Hardcoding the placeholder breaks local development.

5. **`dotnet ef migrations script` writes a UTF-8 BOM**, and a script with nothing pending is
   exactly three bytes of BOM. Scanners strip it; "empty" is never read as "safe".

6. **The template's `Microsoft.AspNetCore.OpenApi` carried a known advisory (NU1903).** The
   `pre` stage builds with `-warnaserror`, so it failed the build — correctly. The package was
   removed rather than suppressed. A gate that gets waived is not a gate.

## Tests

`PostgresFixture` has two transports (decision D2 in `docs/v1-plan.md`): it uses
`ConnectionStrings__Test` when the pipeline injects one, and starts Testcontainers when it is
absent. The tests cannot tell the difference, so the same suite runs on a laptop and in CI.
