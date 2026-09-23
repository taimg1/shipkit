# Restore production from a backup

> **Drill performed 2026-09-22 against production** (`easy-transfer`, 173.242.57.83, service
> `easytransfer-api`). The newest dump the pipeline had written was restored into a throwaway
> container beside the live database: `pg_restore` exited 0 in **0.261 s** with no diagnostics,
> and the result was row-for-row identical to production — 17 tables, 190 rows, and a
> `__EFMigrationsHistory` whose 29 rows hash the same on both sides. Production was read and
> never written; the scratch container was removed and the removal proved. Numbers, commands
> and the four defects this drill found in this runbook are in
> [The 2026-09-22 production drill](#the-2026-09-22-production-drill).
>
> **Drill performed 2026-09-12** against `dev-server`. The schema was destroyed with
> `DROP SCHEMA public CASCADE` and rebuilt from a dump this kit produced. Both tables came back,
> both rows came back with their values intact (`ORD-A`, `ORD-B`), the migration history was
> preserved, and the application served `/orders` with real data again. That method belongs to a
> disposable server. **Never rehearse by dropping production's schema** — rehearse with the
> scratch-container drill below, which cannot touch the live database at all.
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
  creates `/var/backups/shipkit`). They are not encrypted at rest. Confirmed on production
  2026-09-22: `drwx------ deploy deploy` and `-rw------- deploy deploy` — the deploy user can
  read them, nobody else but root can.
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

### Finding the deploy report

The runbook tells you to compare the dump's digest against `backup.sha256` in the deploy
report. **Where that report is depends on who ran the deploy, and the kit keeps no copy on the
server** — `/home/deploy/.shipkit/` is empty, and there is no `*/runs/*.json` anywhere on the
machine. Looking for one there is a dead end (found 2026-09-22).

- **Deployed from a laptop:** `<repo>/.shipkit/runs/<timestamp>-<sha>.json`.
- **Deployed by CI (`deploy --auto`), which is the normal case:** the report exists only as a
  GitHub Actions artifact on the run that deployed it.

```bash
gh run list --repo <owner>/<repo> --limit 10             # find the run that deployed <sha>
gh run download <run-id> -n report-deploy -D ./report    # -> ./report/deploy.json
jq '.stages[] | select(.name=="backup") | .backup' ./report/deploy.json
```

Artifacts expire. If the report for a dump is already gone, the dump's digest can no longer be
checked against what the pipeline recorded — say so rather than implying it was verified.

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

### `entries` in the report is not the archive's entry count

The `backup` stage reports `entries`, and it is tempting to read it as "how many objects the
dump holds". It is not. The module lists the archive with `pg_restore --list … | head -40` and
counts the numbered lines that survive; the custom-format header is 15 comment lines, so
**`entries` saturates at 25** and any real dump reports exactly 25
(`.dagger/src/core/backup.ts`). Production's dump on 2026-09-22 reported `entries: 25` and
actually holds **109** numbered entries (header: `TOC Entries: 113`).

The gate itself is sound — it only asks whether the listing was readable at all (`entries <= 0`
fails) — but the number is not comparable with anything. Count the archive yourself when you
need the real figure:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> \
  'pg_restore --list < /var/backups/shipkit/<service>/<file>.pgc | grep -c "^[0-9]*;"'
```

`pg_restore --list -` does **not** mean stdin — PG 17 tries to open a file named `-` and fails.
Omit the filename argument entirely and it reads stdin.

## Restore it

Identify the database container, the target database **and the database role** first —
restoring into the wrong one is the mistake this runbook exists to prevent.

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> 'docker ps --format "{{.Names}}"'
```

**The role is not `postgres`.** The accessory is provisioned with `POSTGRES_USER` from
`dbUser:` in shipkit.yaml, and that is the only role that exists — on production
`psql -U postgres` answers `FATAL: role "postgres" does not exist`. Take `<db user>` and
`<database>` from shipkit.yaml (`dbUser:`, `database:`), or read them off the running app:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> \
  'docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" <service>-web-<sha> | grep -i ConnectionStrings'
# Host=…;Database=<database>;Username=<db user>;Password=…   — that output contains the password
```

Pick the file — normally the one named after the deploy that went wrong, or the `path` in that
deploy's report — and check it is the file that was verified:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> 'sha256sum /var/backups/shipkit/<service>/<file>.pgc'
# must equal backup.sha256 in the deploy report (see "Finding the deploy report")
```

Then restore it on the server, where the file already is:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> \
  'docker exec -i <service>-db pg_restore -U <db user> -d <database> \
     --no-owner --no-privileges --exit-on-error --single-transaction \
     < /var/backups/shipkit/<service>/<file>.pgc'
```

From a local copy (`shipkit backup --out`) the same command reads the file from stdin instead:
`cat prod-….pgc | ssh … 'docker exec -i <service>-db pg_restore … --exit-on-error --single-transaction'`.

`--no-owner --no-privileges` because the roles in the dump need not exist on the machine
being restored to — and with them there are no ownership warnings left to ignore. **A non-zero
exit is a failed restore.** `--exit-on-error --single-transaction` make it all or nothing: an
error rolls the whole restore back instead of leaving half a database that looks restored.

A custom-format dump does not care that the database it came from had a different name: the
2026-09-22 drill restored a dump of `easytransfer` into `easytransfer_drill` with no complaint.

**Restoring into a database that still has the old objects will fail on conflicts.** Either
restore into an empty database, or drop the schema first — deliberately, with the current
backup already in hand:

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
-- and every other schema the application uses (EF's HasDefaultSchema)
```

## Rehearse it: restore into a scratch database

Everything above points at the live container, because that is where a real recovery goes. **To
practise, do not point it there.** Start a throwaway Postgres beside the app, restore into that,
compare, and delete it. This is the drill to run on a new server, and the one performed on
2026-09-22.

Two properties make it safe, and both are worth keeping: `--network none`, so the scratch
container has no route to the live database even by accident, and a container name of your own
that you remove by name with `-v`. Never `docker system prune` or `docker volume prune` on a
server that runs something.

```bash
DUMP=/var/backups/shipkit/<service>/<file>.pgc
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> bash -s <<'EOF'
set -e
# 0. snapshot, so the cleanup can be proved later
docker ps -a --format '{{.Names}}' | sort > /tmp/ps.before
docker volume ls -q | sort > /tmp/vol.before
docker ps -a --filter 'name=^shipkit-restore-drill$' --format '{{.Names}}'   # must print nothing

# 1. a scratch server on the same image as the accessory, reachable by nothing
docker run -d --name shipkit-restore-drill --network none \
  -e POSTGRES_USER=<db user> -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=<database>_drill \
  postgres:17-alpine
until docker exec shipkit-restore-drill pg_isready -U <db user> -d <database>_drill >/dev/null 2>&1
do sleep 1; done
EOF
```

Then the restore itself, timed, from the dump already on the server:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> "
  s=\$(date +%s.%N)
  docker exec -i shipkit-restore-drill pg_restore -U <db user> -d <database>_drill \
    --no-owner --no-privileges --exit-on-error --single-transaction < $DUMP
  rc=\$?
  echo \"restore_rc=\$rc restore_seconds=\$(echo \"\$(date +%s.%N)-\$s\" | bc)\"
"
```

Check it (see below), then remove it and prove nothing is left:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> bash -s <<'EOF'
docker rm -f -v shipkit-restore-drill
docker ps -a --format '{{.Names}}' | sort | diff /tmp/ps.before -   # no output = clean
docker volume ls -q | sort      | diff /tmp/vol.before -            # no output = clean
docker inspect -f '{{.State.StartedAt}} {{.State.Status}}' <service>-db   # unchanged = never restarted
EOF
```

`StartedAt` is the honest proof that the live database was not disturbed: compare it before and
after. An accessory that was restarted has a new one.

Measuring the start-up is not the same as measuring the restore. A poll loop run over a fresh
SSH connection will usually report ~0 s because the container finished initialising in the gap
between two connections. Take the real figure from the container's own log:

```bash
docker inspect -f '{{.State.StartedAt}}' shipkit-restore-drill
docker logs -t shipkit-restore-drill | grep 'ready to accept connections'   # the PID 1 line, not the init server's
```

## Check that it worked

Quoting a catalog query through `ssh` and `docker exec` is where these checks go to die — the
nested `'"'"'…'"'"'` form is unreadable and easy to get wrong. Feed the SQL in on stdin instead:

```bash
ssh -i "$SHIPKIT_SSH_KEY" <user>@<host> \
  'docker exec -i <service>-db psql -v ON_ERROR_STOP=1 -U <db user> -d <database> -tA -f -' <<'SQL'
select n.nspname, c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
order by 1, 2;
SQL
```

Every table the application had should be listed — the deploy report's `backup.productionTables`
says how many there were.

When several `psql` calls run inside one `ssh … bash -s` script, give each one `</dev/null`.
Otherwise `docker exec -i` reads the rest of the script as the query's input and the remaining
commands silently never run — which looks like a check that passed.

Row counts are the check worth doing, and production can be read for the comparison without
being written to:

```sql
select '<table>' t, count(*) from "<table>" union all …   -- same text against both databases
select md5(string_agg(migration_id || '|' || product_version, E'\n' order by migration_id))
from "__EFMigrationsHistory";
```

Rows written after the dump was taken are an expected difference, not a fault — the dump's name
carries the UTC minute it was taken, so the window is known. A **missing** table, a **lower**
count on the restored side for a table nobody wrote to, or a different migration-history hash
are faults.

Then look at the application, not just the database: request something that reads real rows.
A schema that exists and a schema that holds the right data are different claims.

## The 2026-09-22 production drill

Run against production (`easy-transfer`, 173.242.57.83, host `vps-60354`) as the pipeline's own
`deploy` user with `~/.ssh/shipkit_deploy_easytransfer`. Kit pinned at `63ffda5`. PostgreSQL
17.11 on both sides, `postgres:17-alpine` already on the server — no pull. No `shipkit`,
`dagger` or `kamal` command was run, and the root key was not used. Every line below was
observed.

**What was restored.** `/var/backups/shipkit/easytransfer-api/8beae0d-20260922T125501Z.pgc`,
92136 bytes, written 2026-09-22 12:55:07 UTC by the deploy of commit `8beae0dcea0ce42…823d0`.

**Digest against the deploy report.** The report is a CI artifact (run `35729204476`, artifact
`report-deploy`). `sha256sum` on the server and `backup.sha256` in the report are the same
string — `3502b19606b4e7d7169f94232056ecfb54a4a614a03b84ba8a204114b4f41321` — and `backup.bytes`
(92136) matches the file. The stored dump is the dump the pipeline verified.

**Timings.**

| | |
|---|---|
| dump size | 92 136 bytes (9 238 kB database) |
| scratch container ready | 2.118 s (from its own log; the poll loop's 0.098 s is an artefact) |
| **`pg_restore`, exit 0** | **0.261 s** |
| whole drill, start to cleanup | 160 s (16:59:39Z → 17:02:19Z) |

`pg_restore --no-owner --no-privileges --exit-on-error --single-transaction` wrote **nothing at
all** to stderr — not a warning, not a notice.

**What came back.** 17 tables (report: `productionTables: 17`, `restoredTables: 17`), 58 indexes,
46 constraints (17 PK, 17 FK, 12 other), 0 sequences, 9 393 843 bytes. The archive holds 109
numbered TOC entries — 17 TABLE, 17 TABLE DATA, 17 PK, 41 INDEX, 17 FK.

**Restored against production, read at 17:01:57 UTC.** All 17 tables, **delta 0 on every one**:

```
__EFMigrationsHistory 29   blog_posts 8    booking_luggage_items 3   booking_stops 10
bookings 5                 driver_profiles 1   notification_deliveries 11   phone_blocks 13
route_guides 40            routes 24       trip_assignments 2        user_role_assignments 10
users 5                    vehicle_classes 3   vehicle_conditional_capacities 2
vehicle_loadout_variants 15                vehicles 9                      total 190
```

Nothing was written to production between the 12:55 dump and the 17:01 read, so the expected
"rows added since the dump" difference is empty here — on a busier database it would not be, and
that is not a fault. Structure matched as well: 17/17 tables, 58/58 indexes, 46/46 constraints.
`__EFMigrationsHistory` is byte-identical — 29 rows both sides, md5 of the ordered
`migration_id|product_version` = `627572f338441d23d76144540381156f` on both, latest
`20260914063401_BookingRowVersion`.

**The only difference found anywhere** was the physical size: production 9 459 379 bytes,
restored 9 393 843 — exactly 65 536 bytes (one 64 KiB chunk) more in the live database. That is
free space in a database that has been written to, not data.

**Production was not disturbed.** `easytransfer-api-db` reported `StartedAt`
`2026-09-16T18:17:18.950711927Z` before and after, to the nanosecond. It was only ever read,
with `psql -tA` SELECTs. The container and volume listings before and after the drill are
identical, `shipkit-restore-drill` appears in neither of the "after" snapshots, and all three
`.pgc` files still have their original bytes, modes, mtimes and digests.

### What this runbook got wrong

Four things, all found by following it literally:

1. **`-U postgres` was wrong in two commands** — the restore and the verification query. That
   role does not exist on this server; the accessory's role is `POSTGRES_USER`/`dbUser:`. Both
   commands failed as written. Fixed above.
2. **There was no drill procedure, and the only restore command pointed at the live container.**
   Anyone rehearsing by following the page would have restored into production. The scratch
   drill above is what was actually run, and the 2026-09-12 `DROP SCHEMA public CASCADE` method
   now carries the warning it needed.
3. **The verification query was not runnable as printed** over `ssh` + `docker exec` without
   rewriting its quoting; and `psql` inside a `bash -s` script eats the rest of the script
   unless it is given `</dev/null`. Both are now written the way they have to be typed.
4. **`backup.sha256` was to be compared against `.shipkit/runs/…json`, which does not exist for
   a CI deploy** — the kit stores no report on the server, and the file only exists locally when
   a person ran the deploy. The `gh run download` path is now written down.

And one gap that is not this runbook's fault but reads like one: the report's `entries` field
saturates at 25 and cannot be compared against the archive. Documented above.

## Afterwards

The application does not need restarting — it holds no schema state. Migrations are not
re-applied: the dump carries `__EFMigrationsHistory`, so the database knows exactly where it
stands, and the next deploy computes pending migrations from it. The 2026-09-22 drill confirms
the first half of that claim directly: the restored history was identical to production's, 29
rows, same hash.

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
