# Restore production from a backup

> **Drill performed 2026-09-12** against `dev-server`. The production schema was destroyed
> with `DROP SCHEMA public CASCADE` and rebuilt from a dump this kit produced. Both tables
> came back, both rows came back with their values intact (`ORD-A`, `ORD-B`), the migration
> history was preserved, and the application served `/orders` with real data again.
>
> Repeat this on every new server before the first client goes live, and record the date
> here. Until a restore has actually been performed, the backup strategy is an assumption.

## Take a backup

```bash
export SHIPKIT_SSH_KEY=path/to/deploy_key
shipkit backup --out prod-$(date +%Y%m%d-%H%M).pgc
```

This does not merely write a file. It dumps production, checks the archive's table of
contents, restores it into a scratch database, and fails unless that restore produced
tables. An empty-but-valid custom-format dump is about 800 bytes, so a size check proves
almost nothing.

## Restore it

Identify the database container and the target database first — restoring into the wrong one
is the mistake this runbook exists to prevent.

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> 'docker ps --format "{{.Names}}"'
```

Then:

```bash
cat prod-YYYYMMDD-HHMM.pgc \
  | ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> \
      'docker exec -i <service>-db pg_restore -U postgres -d <database> --no-owner --no-privileges'
```

`--no-owner --no-privileges` because the roles in the dump need not exist on the machine
being restored to. `pg_restore` exits non-zero on benign ownership warnings; the verdict is
what the database contains afterwards, not the exit code.

**Restoring into a database that still has the old objects will fail on conflicts.** Either
restore into an empty database, or drop the schema first — deliberately, with the current
backup already in hand:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
```

## Check that it worked

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> \
  'docker exec <service>-db psql -U postgres -d <database> -tAc \
     "select table_name from information_schema.tables where table_schema = '"'"'public'"'"'"'
```

Then look at the application, not just the database: request something that reads real rows.
A schema that exists and a schema that holds the right data are different claims.

## Afterwards

The application does not need restarting — it holds no schema state. Migrations are not
re-applied: the dump carries `__EFMigrationsHistory`, so the database knows exactly where it
stands, and the next deploy computes pending migrations from it.

If the restore was needed because a migration went wrong, **do not write a `Down` migration**.
Ship a new migration that corrects the state and deploy forward (ADR 0005).
