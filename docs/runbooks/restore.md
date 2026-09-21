# Restore production from a backup

> **Drill performed 2026-09-12** against `dev-server`. The production schema was destroyed
> with `DROP SCHEMA public CASCADE` and rebuilt from a dump this kit produced. Both tables
> came back, both rows came back with their values intact (`ORD-A`, `ORD-B`), the migration
> history was preserved, and the application served `/orders` with real data again.
>
> Repeat this on every new server before the first client goes live, and record the date
> here. Until a restore has actually been performed, the backup strategy is an assumption.

## Where the backups are

Every deploy that reaches the `backup` stage stores its verified dump **on the server**, before
`migrate` runs:

```
/var/backups/shipkit/<service>/<sha>-<UTC timestamp>.pgc      e.g. a1b2c3d-20260919T123456Z.pgc
```

- `<service>` is `service:` from shipkit.yaml; `<sha>` is the commit that was about to be
  deployed, so "the backup from before deploy X" is the file named after X.
- Each file is `0600`, in a `0700` directory owned by the deploy user (`server/bootstrap.sh`
  creates `/var/backups/shipkit`). They are not encrypted at rest.
- A file only gets its final name after it was restored into a scratch database with every
  table production has, uploaded, and its sha256 compared with the verified copy. A half-written
  upload stays a hidden `.…partial` file and is never counted as a backup.
- The newest `backupRetention` files are kept (shipkit.yaml, default 10); older ones are
  deleted after each new one is stored. Files not named by the kit are left alone.
- The deploy report's `backup` stage has `path` and `sha256`. `shipkit deploy --plan` shows the
  newest one as `last verified`.
- If the dump cannot be stored, the `backup` stage fails and **migrate does not run**.

This is a copy on the machine it protects. It covers a bad migration; it does not cover losing
the server. See [Off-site copy](#off-site-copy-not-yet-implemented--design-sketch).

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> 'ls -l /var/backups/shipkit/<service>/'
```

## Take a backup by hand

```bash
export SHIPKIT_SSH_KEY=path/to/deploy_key
shipkit backup --out prod-$(date +%Y%m%d-%H%M).pgc
```

The same code the deploy runs: it dumps production, checks the archive's table of contents,
restores it into a scratch database, and fails unless that restore finished without an error
and produced at least as many tables as production has, in every schema. An
empty-but-valid custom-format dump is about 800 bytes, so a size check proves almost nothing.
The dump is stored on the server like a deploy's (it counts towards retention) and also
written to `--out`.

`--out` is production data, unencrypted: it is written with mode `0600`. Keep it off shared
machines and synced folders, and delete it when the drill is over.

## Restore it

Identify the database container and the target database first — restoring into the wrong one
is the mistake this runbook exists to prevent.

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> 'docker ps --format "{{.Names}}"'
```

Pick the file — normally the one named after the deploy that went wrong, or the `path` in that
deploy's report — and check it is the file that was verified:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> 'sha256sum /var/backups/shipkit/<service>/<file>.pgc'
# must equal backup.sha256 in the deploy report (.shipkit/runs/…json)
```

Then restore it on the server, where the file already is:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> \
  'docker exec -i <service>-db pg_restore -U postgres -d <database> \
     --no-owner --no-privileges --exit-on-error --single-transaction \
     < /var/backups/shipkit/<service>/<file>.pgc'
```

From a local copy (`shipkit backup --out`) the same command reads the file from stdin instead:
`cat prod-….pgc | ssh … 'docker exec -i <service>-db pg_restore … --exit-on-error --single-transaction'`.

`--no-owner --no-privileges` because the roles in the dump need not exist on the machine
being restored to — and with them there are no ownership warnings left to ignore. **A non-zero
exit is a failed restore.** `--exit-on-error --single-transaction` make it all or nothing: an
error rolls the whole restore back instead of leaving half a database that looks restored.

**Restoring into a database that still has the old objects will fail on conflicts.** Either
restore into an empty database, or drop the schema first — deliberately, with the current
backup already in hand:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
-- and every other schema the application uses (EF's HasDefaultSchema)
```

## Check that it worked

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> \
  'docker exec <service>-db psql -v ON_ERROR_STOP=1 -U postgres -d <database> -tAc \
     "select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('"'"'r'"'"', '"'"'p'"'"') and n.nspname <> '"'"'information_schema'"'"'
        and n.nspname !~ '"'"'^pg_'"'"' order by 1, 2"'
```

Every table the application had should be listed — the deploy report's `backup.productionTables`
says how many there were.

Then look at the application, not just the database: request something that reads real rows.
A schema that exists and a schema that holds the right data are different claims.

## Afterwards

The application does not need restarting — it holds no schema state. Migrations are not
re-applied: the dump carries `__EFMigrationsHistory`, so the database knows exactly where it
stands, and the next deploy computes pending migrations from it.

If the restore was needed because a migration went wrong, **do not write a `Down` migration**.
Ship a new migration that corrects the state and deploy forward (ADR 0005).

## Off-site copy: not yet implemented — design sketch

> **Not implemented.** Nothing below exists in the kit. It is written down so the gap is
> visible and the next step is agreed, not so anyone relies on it. Today the only copies are
> the ones on the server and any `--out` file someone kept.

A backup on the server it protects survives a bad migration and nothing else: a lost disk, a
deleted VPS or a compromised host takes the backups with it. The sketch, adding no new
infrastructure to the kit itself:

- **Where:** an S3-compatible bucket the client already pays for (their provider's object
  storage), with versioning and a lifecycle rule. Bucket and credentials come from shipkit.yaml
  and a Dagger secret, like the registry token.
- **When:** in the `backup` stage, after the server copy is stored and before `migrate` — so
  the rule stays "no verified, stored backup, no migration", now meaning both copies.
- **What:** the same file, encrypted before it leaves (e.g. `age` to a recipient key held
  outside the server), uploaded under the same name, its sha256 re-checked from the bucket.
- **Fail closed:** an upload that fails fails the stage. Retention in the bucket is the
  lifecycle rule's job, not the kit's.
- **Also needed:** a restore drill from the bucket on a fresh server, and a freshness alert
  (`docs/runbooks/monitoring.md` does not watch backups yet).

