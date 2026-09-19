# Deploy

```bash
export SHIPKIT_SSH_KEY=path/to/deploy_key
export SHIPKIT_DATABASE_URL="Host=...;Database=...;Username=...;Password=..."

shipkit deploy --plan          # shows what would happen; changes nothing
shipkit deploy --yes=<token>   # runs exactly that plan
```

## Read the plan before confirming

```
  target      prod  (https://api.client.com)
  image       sha-a1b2c3d  <-  currently sha-9f8e7d6
  migrations  20260911_AddOrdersIndex
  sql         12 lines
  backup      will run first; last verified 2026-09-10 03:00

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

## What runs

`backup` → `migrate` → `release` → `verify` → `rollback` (only if verify fails) → `clean`.

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
| 4 | Needs confirmation | Run `--plan`, read it, then `--yes=<token>` |

A failed `verify` triggers a rollback automatically and the run still ends red. That is
correct: the deploy did not happen, and a green run would say it did.

## For agents

Never pass `--yes` without showing the plan and getting an explicit yes for *that* plan in
the conversation. The token proves the plan was displayed; it does not prove anyone agreed
to it.
