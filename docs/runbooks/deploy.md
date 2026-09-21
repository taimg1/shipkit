# Deploy

```bash
export SHIPKIT_SSH_KEY=path/to/deploy_key
export SHIPKIT_DATABASE_URL="Host=...;Database=...;Username=...;Password=..."

shipkit deploy --plan          # shows what would happen; changes nothing
shipkit deploy --yes=<token>   # runs exactly that plan
shipkit deploy --auto          # for the pipeline: run it, or stop with exit 4 and the plan
```

`--plan`, `--yes` and `--auto` are three answers to the same question, and giving two of them
at once is an error rather than one of them quietly winning.

## Read the plan before confirming

```
  target      prod  (https://api.client.com)
  image       sha-a1b2c3d4…  <-  currently sha-9f8e7d6…   (tags carry the full commit)
  migrations  20260911_AddOrdersIndex
  sql         12 lines
  backup      will run first; last verified 9f8e7d6-20260910T030012Z.pgc (2026-09-10T03:00:14Z)

  to execute: shipkit deploy --yes=7f3a91c2e004
```

Three things are worth a second look every time:

- **The migration list.** If it is longer than you expect, someone else's migration is
  riding along in this deploy.
- **`destructive: true`** in the JSON, or a `DROP` in the SQL. That deploy needs the
  expand/contract treatment, not a confirmation.
- **A `WARNING` about Kamal and `/health` disagreeing.** Kamal reports the version from the
  `latest` tag; if that disagrees with what is answering, something moved the tag by hand
  and a rollback would go to the wrong image. Sort that out before deploying.

The token is a hash of the plan. If anything in it changes — a new commit, another migration
merged, production moved under you — the token stops matching and the deploy refuses. Run
`--plan` again and read what changed rather than reaching for a fresh token.

The token also names the stages. A plan shown without `--stage` confirms the whole deploy and
nothing less; to run part of it, ask for a plan of that part (`shipkit deploy --plan
--stage=backup,migrate`) and confirm with the same `--stage`. Some sets are refused whatever
the token says, because they skip a gate:

- `release` without `verify` — nothing would check the new version, and nothing would roll it back;
- `release` without `migrate` while migrations are pending — new code on the old schema;
- `migrate` without `backup` while migrations are pending.

## The automatic path

A merge to the default branch deploys itself. The `deploy` job in `.github/workflows/ci.yml`
(`templates/github/ci.yml` in the kit) `needs` the `ci` job, so it runs on the same commit, in
the same run, after the job that published the image — what it releases is by construction what
this run built. It calls `shipkit deploy --auto`, and one deploy runs at a time: the job's
concurrency group holds the next merge until this one is finished, and never cancels a deploy
in flight.

`--auto` does not approve anything. It says that nobody is waiting at a terminal; the module
decides, and it self-approves only a plan where **all** of these hold:

- no destructive SQL — no `DROP COLUMN`, no `DROP TABLE`, no `ALTER COLUMN`;
- no `-- shipkit:allow-loss` marker in the pending migrations. An intentional loss is still a
  loss, and the person who declared it in a migration is not the person watching this deploy;
- nothing to provision — the server already has what it needs. A first deploy, or one that
  boots the database, is a change to the machine, confirmed like one;
- the image for this commit is published, which is the same gate a confirmed deploy passes.

Everything else stops: exit 4, nothing on the server touched, and the job red. A red job is
the point — a merge that did not reach production must not look like one that did. The run's
step summary carries the plan, the reason, and the token; `report-deploy` in the run's
artifacts has the full report.

The ordinary gates are unchanged and are *not* confirmation questions: a backup that cannot be
verified, a migration that fails, a `verify` that does not see the new SHA — those fail the
deploy (exit 1), and a failed `verify` still rolls back on its own.

### Confirming a deploy that stopped

Re-running the job changes nothing: it will stop at the same place for the same reason. The
plan needs a person.

```bash
git fetch && git checkout <the commit from the run>   # a clean tree; --auto and --yes both refuse a dirty one
export SHIPKIT_SSH_KEY=path/to/deploy_key
export SHIPKIT_DATABASE_URL="Host=...;Database=...;Username=...;Password=..."
# and every variable .kamal/secrets refers to, as the deploy job exports them

shipkit deploy --plan            # read it: it is built from production as it is now
shipkit deploy --yes=<token>     # the token this plan printed
```

Take the token from `--plan`, not from the run summary. The summary's token was correct when
the job stopped; if production has moved since — someone else deployed, another migration
landed — it no longer matches and the deploy refuses, which is the confirmation working. Read
what changed and confirm the new plan.

If the plan is one that should not be deployed at all — a `DROP COLUMN` that should have been
an expand/contract pair — fix it in a new commit. Nothing is left half-done on the server: a
deploy that stopped for confirmation never started.

## What runs

`provision` (only when the plan says so) → `backup` → `migrate` → `release` → `verify` →
`rollback` (only if verify fails) → `clean`.

`verify` passes only when `/health` reports the SHA just deployed **and** the readiness path
(`ready:` in shipkit.yaml) answers 200 — the new release can reach its database. It retries
both for up to `verifyTimeout` seconds (default 60) before failing.

`--stage` selects a subset. `rollback` cannot be selected — it only ever follows a failed
verify; use `shipkit rollback` instead. A plan that provisions the server refuses a selection
that leaves `provision` out.

Before any of them, and before anything on the server changes:

1. **The deploy lock** is taken on the server (`~/.shipkit/deploy-lock-<service>` in the SSH
   user's home). A second deploy started meanwhile is refused and told who holds the lock —
   sha, environment, who ran it, since when. It is released when the run ends, whether it
   succeeded, failed, or rolled back. It is separate from Kamal's own lock
   (`~/.kamal/lock-<service>`), which Kamal still takes inside `release`, `rollback` and `clean`.
2. **The image is pulled** onto the server with `kamal build pull` — the registry, credentials
   and hosts `release` will use. An image that was never published (a branch, a red `ci`, a
   wrong sha) stops the deploy here, before the backup and the migrations, rather than at
   `release` with production already on the new schema.

`backup` dumps production, restores the dump into a scratch database (it must restore without
an error and with every table production has), and stores it on the server as
`/var/backups/shipkit/<service>/<sha>-<UTC timestamp>.pgc` (mode 0600), keeping the newest
`backupRetention` (default 10). The stage's report entry has the `path` and `sha256`. If the
dump cannot be verified or stored, the stage fails and `migrate` does not run. Restoring from it:
`docs/runbooks/restore.md`. A server bootstrapped before this existed needs the directory once — re-run
`server/bootstrap.sh` (idempotent) or `sudo install -d -m 700 -o deploy -g deploy /var/backups/shipkit`.

Everything before `release` is recoverable: a failed backup or a failed migration leaves the
old version serving. A failed migration leaves the schema as far as it got — migrations roll
forward, and `restore.md` covers the rest.

`migrate` runs the bundle with `lock_timeout` and `statement_timeout` set (`migrations:` in
`shipkit.yaml`, default 5s / 15min); see add-a-migration.md.

## A deploy lock that was left behind

The lock is released by the run that took it. If that run was killed — the terminal closed,
the engine died — the lock stays, and every later deploy is refused with the holder's details.
Before removing it, make sure that deploy really is gone and look at what it left: the report
of the killed run, `kamal app version`, and the applied migrations. Then, on the server:

```bash
cat ~/.shipkit/deploy-lock-<service>/holder   # who held it and since when
rm -rf ~/.shipkit/deploy-lock-<service>
```

Never remove Kamal's `~/.kamal/lock-<service>` this way; that one is `kamal lock release`.

## When it fails

| Exit | Meaning | What to do |
|---|---|---|
| 1 | A gate said no — including an image that cannot be pulled and a deploy lock that is held | Read the stage that failed; the reason names the cause |
| 2 | Configuration | `shipkit doctor` |
| 3 | Infrastructure | The engine, the server, or the registry — retry after fixing |
| 4 | Needs confirmation | Run `--plan`, read it, then `--yes=<token>`. From the automatic path: "Confirming a deploy that stopped" above |

**`Host key verification failed`** (or net-ssh's `HostKeyMismatch` from Kamal) means the
server presented a key other than the one pinned as `hostKey` in `shipkit.yaml`. Treat it as a
possible interception until proven otherwise: do not re-pin from what the deploy saw. If the
server was rebuilt, take the new key from the server itself
(`docs/runbooks/server-bootstrap.md` §4) and change `hostKey` in a reviewed commit.

A failed `verify` triggers a rollback automatically and the run still ends red. That is
correct: the deploy did not happen, and a green run would say it did. The rollback is verified
the same way; if it fails too, the report carries both errors and the run exits 1.

## For agents

Never pass `--yes` without showing the plan and getting an explicit yes for *that* plan in
the conversation. The token proves the plan was displayed; it does not prove anyone agreed
to it.

`--auto` is the pipeline's flag, not a shortcut around that. It exists because on a merge there
is no conversation to have; running it by hand deploys without showing anyone anything, and a
plan safe enough to self-approve is also a plan that takes ten seconds to show. Use `--plan`.
