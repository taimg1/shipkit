# The registry

When the image will not publish, or the server will not pull it. Everything below was run
against a registry that really did require a password — see "What was actually tested".

The chain has two halves and they use different credentials for different reasons:

| Who | What it does | Credential |
|---|---|---|
| `ci` push stage, in the pipeline | uploads `<registry>:sha-<commit>` | `SHIPKIT_REGISTRY_TOKEN`, sent as `SHIPKIT_REGISTRY_USER` / `GITHUB_ACTOR` |
| the **server**, during `deploy` | pulls that image | `KAMAL_REGISTRY_PASSWORD`, sent as `registry.username` from `config/deploy.yml` |

The kit injects `SHIPKIT_REGISTRY_TOKEN` into Kamal's container as `KAMAL_REGISTRY_PASSWORD`,
so on GitHub Actions one token usually does both. A private package pulled by a server is the
case where it should not — see [A private package](#a-private-package).

## What a client repo needs for GHCR

1. **`registry:` in shipkit.yaml is the repository, lowercase, with no tag.**

   ```yaml
   registry: ghcr.io/acme/billing-api     # not ghcr.io/Acme/... — see below
   ```

   GitHub organisation names keep their capitals everywhere else; a registry does not accept
   them. `ghcr.io/Acme/billing-api` fails the push with *"repository name must be lowercase"*.
   The kit now refuses that shape as a configuration error (exit 2) before it builds anything.

   It must also agree with `config/deploy.yml`, which is what the server pulls from:
   `registry.server` + `/` + `image:` must be the same string. Nothing cross-checks this yet;
   when they disagree the deploy fails at its first step, before anything on the server
   changes, with Kamal unable to find the image.

2. **`packages: write` on the `Image` job, and on no other.** That is the job that runs
   `shipkit ci --stage=build,push`; `templates/github/ci.yml` has it:

   ```yaml
   permissions:
     contents: read
     packages: write        # the push stage uploads the image with this job's GITHUB_TOKEN
   ```

   Repository-wide `permissions: contents: read` at the top of the file, widened on that one
   job. The analysis, test and migration jobs run the same code against the same commit and
   have nothing to publish, so a compromised action in one of them has no token to publish
   with. No PAT is needed to *publish* to a package owned by the same account as the repo.

3. **The token, only on the runs that may publish.**

   ```yaml
   env:
     SHIPKIT_REGISTRY_TOKEN: ${{ github.event_name == 'push' && secrets.GITHUB_TOKEN || '' }}
   ```

   A pull request run is not handed a token at all. It would not publish anyway — the module
   refuses any branch that is not the default one (`core/publish-gate.ts`) — but a token that
   is never in the environment cannot leak from it either.

4. **Nothing for the username on GitHub Actions.** The kit sends `GITHUB_ACTOR`, which is the
   account `GITHUB_TOKEN` belongs to. Elsewhere — a local run, Gitea, a PAT — export
   `SHIPKIT_REGISTRY_USER`; without it the kit sends `shipkit`, and a registry that checks
   usernames answers 401 to a perfectly good token.

5. **`.kamal/secrets` must have the registry line**, exactly this, a reference and not a value:

   ```
   KAMAL_REGISTRY_PASSWORD=$KAMAL_REGISTRY_PASSWORD
   ```

   The kit deliberately does not resolve this one (`expandSecretsFile` in `bin/lib.mjs`): it
   injects the token into Kamal's container as an environment variable instead, and this line
   is what lets Kamal read it. Kamal does **not** fall back to the environment on its own.
   Without the line, every Kamal command fails before touching the server with:

   ```
   Secret 'KAMAL_REGISTRY_PASSWORD' not found in .kamal/secrets
   Secret 'KAMAL_REGISTRY_PASSWORD' not found, no secret files (.kamal/secrets-common, .kamal/secrets) provided
   ```

   A **literal** on that line wins over the injected token, silently. `fixtures/dotnet-api`
   ships one (`KAMAL_REGISTRY_PASSWORD=unused-by-a-local-registry`) because dev-server's
   registry has no authentication; a client repo that copies the fixture and forgets this line
   deploys with that string as its password and gets `unauthorized` from GHCR with a correct
   token in its secret store.

## A private package

A package published by a workflow is **private** by default, and `GITHUB_TOKEN` is not a
credential the server can keep: it is created for one job and dies with it. Kamal logs the
server in with it (`docker login` writes `~/.docker/config.json` on the server), so the pull
during that deploy works — and the credential left behind is expired by the next one, which
matters the moment anything pulls outside a deploy.

Pick one, in this order:

1. **A read-only credential for the server.** A PAT (classic) with `read:packages` and nothing
   else, ideally on a machine account that has read access to the package. Put it in the CI
   secret store, pass it as `SHIPKIT_REGISTRY_TOKEN` to whatever runs `shipkit deploy` — a
   terminal today, since no client template has a deploy job — and set `registry.username` in
   `config/deploy.yml` to that account. The pipeline then publishes with one credential and the
   server pulls with another, which is what you want anyway: the machine in production has no
   token that can write to the registry.

   ```yaml
   registry:
     server: ghcr.io
     username: acme-deploy-bot     # the account the read:packages PAT belongs to
     password:
       - KAMAL_REGISTRY_PASSWORD
   ```

2. **Give the repository access to the package** and keep using `GITHUB_TOKEN`: on GitHub,
   Package → Package settings → *Manage Actions access* → add the repository with the **Read**
   role. Enough for the deploy itself; the expiring credential on the server stays a fact. A
   workflow that ever runs `shipkit deploy` needs `permissions: packages: read` on that job —
   it reads the image ci published, it never writes one.

3. **Make the package public.** Only when the image contains nothing that is not already
   public — it is the application, its dependencies and whatever the Dockerfile copied in.
   Publishing still needs `packages: write`; pulling needs no credential at all.

If the package belongs to an **organisation**, check *Settings → Packages → Package creation*
before the first push: an organisation can forbid public packages, and it can require that
packages be created by a PAT rather than a workflow token. The first push is where that policy
shows up, as a 403 that looks like a permissions bug in the kit.

## When it fails

| What you see | What it is |
|---|---|
| `shipkit.yaml: registry "…" is not a repository name a registry accepts` | a capital letter, usually the organisation's |
| `shipkit.yaml: registry "…" names no repository` / `carries a tag` | the value is a host or a full image reference, not a repository |
| `publishing to … failed: … 401 Unauthorized` | the username or the token. The hint names the username that was sent and where it came from |
| `push access denied … no basic auth credentials` | no token reached the pipeline: `SHIPKIT_REGISTRY_TOKEN` was empty for this run |
| `denied: permission_denied: write_package` | the job has no `packages: write`, or the package exists and this account has no write role on it |
| Kamal: `Secret 'KAMAL_REGISTRY_PASSWORD' not found` | the `.kamal/secrets` line above is missing |
| Kamal: `unauthorized` on the pull | a literal in `.kamal/secrets`, an expired `GITHUB_TOKEN`, or a package the server's account cannot read |

The push stage reports the digest the registry answered with, not one it computed locally:

```
push  ok  published=ghcr.io/acme/billing-api:sha-<commit>@sha256:…  digest=sha256:…
```

That digest is what the registry holds under that tag. A rollback selects by tag, so a tag
that has been pushed twice is the one thing that can make it deploy something else — which is
why the tag is the full commit SHA and why a dirty tree never publishes.

## What was actually tested

Verified 2026-09-20, because until then the push stage had only ever run against
`publish: false`: a `registry:2` with htpasswd authentication on a local port, and a Dagger
engine configured to speak to it (`http = true` in `engine.toml` — Dagger will not otherwise
talk plain HTTP to a registry, which is why `dev-server/load-image.sh` exists).

- `shipkit ci --stage=build,push` on a copy of `fixtures/dotnet-api` with `publish: true`
  published `…/shipkit-fixture:sha-0398d884c0f6908a5677c7fe4754674711a8213c`. The digest in
  the report is byte-for-byte the `Docker-Content-Digest` the registry returns for that tag,
  and `docker pull` by tag resolves to the same digest.
- The pulled image is `linux/arm64` — the `targetArch` in shipkit.yaml, not the runner's — and
  carries the `service` label Kamal refuses an image without.
- No token: refused, with "no basic auth credentials". A token with the wrong username: 401.
  Both fail the run (exit 3); neither leaves anything in the registry.
- Kamal 2.12 resolves `registry.password` from `.kamal/secrets` only. With the reference line
  it returns the token the kit injected; with a literal it returns the literal; with neither
  it raises before contacting any server.

Not tested here, and worth knowing: GHCR itself. Its package visibility, its organisation
policies and its `GITHUB_TOKEN` scoping are GitHub's behaviour, described above from GitHub's
documentation, not measured.
