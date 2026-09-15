# Rotate a secret

Per-client GitHub accounts mean per-client secret stores. Where each one lives has to be
written down — `docs/secrets.md` in each client repo — because this is the part that rots
first, and it rots silently.

## What exists

| Secret | Read by | Lives in |
|---|---|---|
| `SHIPKIT_REGISTRY_TOKEN` | `ci` push stage | CI secret store (`GITHUB_TOKEN` on GitHub Actions — nothing to rotate) |
| `SHIPKIT_SSH_KEY` | every deploy stage | CI secret store; the public half in the server's `authorized_keys` |
| `SHIPKIT_DATABASE_URL` | the migration bundle | CI secret store |
| `KAMAL_REGISTRY_PASSWORD`, database passwords | Kamal, via `.kamal/secrets` | CI secret store |

None of them are in the repository. `.kamal/secrets` names variables; it does not hold values.

## Rotating the deploy key

Add before removing — a key removed first locks the pipeline out of the machine it is
supposed to be fixing.

```bash
ssh-keygen -t ed25519 -N "" -C "shipkit-<client>-$(date +%Y%m)" -f ./new_deploy_key
ssh-copy-id -i ./new_deploy_key.pub <user>@<host>       # or append it by hand
```

Update the secret in the CI store, then prove the new key works before removing the old one:

```bash
SHIPKIT_SSH_KEY=./new_deploy_key shipkit deploy --plan
```

That reads production over SSH and changes nothing. Only once it succeeds:

```bash
ssh <user>@<host> 'nano ~/.ssh/authorized_keys'   # remove the old entry
```

Delete the private key from your machine afterwards.

## Rotating the database password

The application and the migration bundle both hold it, so they change together:

1. Change it in PostgreSQL: `ALTER ROLE <user> WITH PASSWORD '<new>';`
2. Update `SHIPKIT_DATABASE_URL` in the CI store.
3. Update the value Kamal injects into the application.
4. Deploy. `verify` proves the application still reaches the database.

Between steps 1 and 4 the running application has a stale password. Plan for the gap or
create a second role, move to it, and drop the first.

## Afterwards

Update `docs/secrets.md` with what was rotated and when. An undocumented rotation is how the
next person discovers a secret exists.
