# Rotate a secret

Per-client GitHub accounts mean per-client secret stores. Where each one lives has to be
written down — `docs/secrets.md` in each client repo — because this is the part that rots
first, and it rots silently.

## What exists

| Secret | Read by | Lives in |
|---|---|---|
| `SHIPKIT_REGISTRY_TOKEN` | `ci` push stage | CI secret store (`GITHUB_TOKEN` on GitHub Actions — nothing to rotate) |
| `SHIPKIT_SSH_KEY` | every deploy stage | CI secret store; the public half in the server's `authorized_keys` |
| `SHIPKIT_DATABASE_URL` | the migration bundle, as the schema owner | CI secret store |
| `KAMAL_REGISTRY_PASSWORD`, database passwords | Kamal, via `.kamal/secrets` | CI secret store |
| the application's connection string (`ConnectionStrings__Default`) | the application, as a role with no DDL rights | CI secret store, via `.kamal/secrets` and `env.secret` |

None of them are in the repository. `.kamal/secrets` names variables; it does not hold values.
A connection string belongs under `env.secret` in `config/deploy.yml`, never `env.clear`: clear
values are committed and shown by `docker inspect`. `fixtures/dotnet-api` is the example to
copy — its only literal is a registry password for a registry with no authentication.

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

## Rotating the database passwords

There are two roles, and they rotate separately: the owner, which only the migration bundle
uses (`SHIPKIT_DATABASE_URL`), and `app`, which only the application uses (its connection
string in `.kamal/secrets`). The fixture creates `app` on first boot; its README has the
commands for a database that predates that.

1. Change it in PostgreSQL. `\password <role>` in an interactive `psql` prompts for it, so the
   new password is not left in shell history or a process list.
2. For the owner: update `SHIPKIT_DATABASE_URL` in the CI store, and `POSTGRES_PASSWORD` with
   it — that one only takes effect when the data directory is first initialised, so changing it
   alone changes nothing, but a stale copy is a wrong password waiting for the next restore. For
   `app`: update the variable `.kamal/secrets` points `ConnectionStrings__Default` at.
3. Deploy. The application's container is replaced with the new value; `verify` proves the
   release took, and `/health/ready` proves it still reaches the database.

Between steps 1 and 3 the running application has a stale password. Plan for the gap or
create a second role, move to it, and drop the first.

## Afterwards

Update `docs/secrets.md` with what was rotated and when. An undocumented rotation is how the
next person discovers a secret exists.
