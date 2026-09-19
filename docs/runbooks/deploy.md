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
  image       sha-a1b2c3d4…  <-  currently sha-9f8e7d6…   (tags carry the full commit)
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

## What runs

`backup` → `migrate` → `release` → `verify` → `rollback` (only if verify fails) → `clean`.

Everything before `release` is recoverable: a failed backup or a failed migration leaves the
old version serving and production untouched.

## When it fails

| Exit | Meaning | What to do |
|---|---|---|
| 1 | A gate said no | Read the stage that failed; the reason names the cause |
| 2 | Configuration | `shipkit doctor` |
| 3 | Infrastructure | The engine, the server, or the registry — retry after fixing |
| 4 | Needs confirmation | Run `--plan`, read it, then `--yes=<token>` |

**`Host key verification failed`** (or net-ssh's `HostKeyMismatch` from Kamal) means the
server presented a key other than the one pinned as `hostKey` in `shipkit.yaml`. Treat it as a
possible interception until proven otherwise: do not re-pin from what the deploy saw. If the
server was rebuilt, take the new key from the server itself
(`docs/runbooks/server-bootstrap.md` §4) and change `hostKey` in a reviewed commit.

A failed `verify` triggers a rollback automatically and the run still ends red. That is
correct: the deploy did not happen, and a green run would say it did.

## For agents

Never pass `--yes` without showing the plan and getting an explicit yes for *that* plan in
the conversation. The token proves the plan was displayed; it does not prove anyone agreed
to it.
