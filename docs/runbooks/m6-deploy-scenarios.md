# M6 — what `deploy` does, verified

Run against `dev-server` on 2026-09-12. Dagger v0.21.9, Kamal v2.12.0, EF Core 10.0.12,
PostgreSQL 17, target architecture arm64. Every line below was observed.

```bash
export SHIPKIT_SSH_KEY=dev-server/.ssh/id_ed25519
export SHIPKIT_DATABASE_URL="Host=shipkit-fixture-db;Port=5432;Database=app;Username=postgres;Password=postgres"

shipkit deploy --plan          # shows the plan, changes nothing, exits 0
shipkit deploy                 # exit 4: this would change production and has no token
shipkit deploy --yes=<token>   # runs it
```

> Since this run the fixture no longer connects as `postgres` with a password in `env.clear`:
> the application uses an `app` role and its connection string is a secret. Rerunning these
> scenarios needs the exports in `fixtures/dotnet-api/README.md`, "Deploying to dev-server".

## The three scenarios the plan asked for

### 1. A normal change

```
  + backup     2.7s
  + migrate    0.2s
  + release    4.5s
  + verify     0.1s
  - rollback           not needed
  + clean      0.5s
  ok  (11.8s)
```

`/health` through kamal-proxy returned the exact commit that was built. On a deploy with
pending migrations, `backup` reported `verified: 3393 bytes, 8 entries, restoredTables: 2` —
the dump was restored into a scratch database and found to contain two tables. A size check
alone would have proved nothing: an empty-but-valid custom-format dump is about 800 bytes.

### 2. A migration that fails

A migration doing `ALTER TABLE orders DROP COLUMN this_column_does_not_exist`:

```
  ok       backup      2.7
  failed   migrate    12.4   Failed executing DbCommand ... Severity: ERROR
  skipped  release           previous stage failed
  skipped  verify            previous stage failed
  skipped  rollback          previous stage failed
  skipped  clean             previous stage failed
```

Exit 1. The old version kept serving throughout, and production was untouched afterwards:
same tables, same applied migration, both rows still there. EF wraps a migration in a
transaction, so the failure rolled itself back.

The plan for that deploy had already said `destructive: True`.

### 3. A release that does not take

An image tagged `sha-badbad0` whose `/health` reports a version nobody deployed:

```
  ok       release     4.4   released=sha-badbad0  previous=sha-47388f5
  failed   verify      0.1   health check reports version "a-version-nobody-deployed",
                             expected "badbad00deadbeefcafe1234567890abcd"
  ok       rollback      4   rolledBackTo=sha-47388f5
                             note=the database was not rolled back; migrations roll forward
  skipped  clean             previous stage failed
```

Exit 1, and `/health` was serving the previous version again afterwards.

This is the scenario `verify` exists for. A status-code check would have called it a success:
the container was up, the proxy was routing, and it answered 200 the whole time — with the
wrong version.

## The rollback was broken until this was run

Two faults, both in the recovery path, both invisible until a deploy was made to fail on
purpose:

- `kamal rollback` rejects `--skip-push`, which had been added by analogy with `release`.
- Kamal still derives a version for its deploy lock from git history, and the source handed
  to it deliberately has none. `--version` is now passed explicitly — the pipeline knows
  which release it is operating on, and a delivery tool guessing that is a guess that can be
  wrong at exactly the wrong moment. `clean` had the same fault.

The first attempt at scenario 3 ended with the bad version still serving: the gate fired, the
recovery did not. **A recovery path that has never been executed is not a recovery path.**

## Two more things worth knowing

**Kamal's idea of the current version comes from the `latest` tag**, not from what is
answering. Anything that moves that tag out of band leaves `kamal app version` describing
something that is not running — and the rollback target is taken from the tag. The plan now
reads `/health` as well and prints a warning when the two disagree.

**The migration bundle runs in a container on the server**, not on the host: it is
dynamically linked against glibc and dev-server is Alpine. Running it in
`mcr.microsoft.com/dotnet/runtime-deps` on the app's own network sidesteps the host's
distribution entirely, and needs no port published for the database.

Npgsql prints `libgssapi_krb5.so.2: cannot open shared object file` in that image. It is
harmless — the connection succeeds — but it appears in the output of every migration and is
easy to mistake for the cause of a failure.

## Still not proven here

TLS via Let's Encrypt, cloud-init and the firewall, off-server backups, and anything
provider-specific. See `dev-server/README.md` — those need a real host and a public name.
