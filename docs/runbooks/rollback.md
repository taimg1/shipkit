# Roll back

A failed `verify` rolls back on its own. This is for the other case: the deploy passed every
gate and the change is still wrong.

```bash
export SHIPKIT_SSH_KEY=path/to/deploy_key
shipkit rollback sha-<previous>
```

## Find the version to go back to

```bash
shipkit deploy --plan        # `currently ...` is what Kamal believes is deployed
curl https://api.client.com/health   # what is actually answering
```

If those disagree, trust `/health` and work out why before rolling anywhere. Kamal derives
its answer from the `latest` tag, and a rollback targets the tag.

## Tags name the whole commit

`ci` tags an image `sha-<40-character commit>`. It used to be the first seven characters, which
collide on a large repository — and a second push under the same tag silently replaces what
`deploy` and `rollback` select. `rollback` still accepts the old `sha-<7>` tags that are on the
server, so going back across the change works.

Deploying a commit **again** does not cross it: `deploy` looks for `sha-<40>`, and a commit
published before the change is in the registry only under `sha-<7>`. Run `ci` for that commit on
the current kit (it publishes the full tag) before redeploying it.

`ci` publishes only on a push to the default branch, and refuses — red, not skipped — when it
cannot tell which branch it is on or when `--sha` is not a full commit. A pull request never
publishes, whatever its branch is called: on GitHub the wrapper takes the branch from the event,
not from the pull request's head branch. The `push` stage records the image's digest in the ci
report (`digest`); deploy still pulls by tag, so compare the two by hand when it matters:
`docker buildx imagetools inspect <registry>:sha-<commit>`.

## The window is `retain_containers` deploys long

`kamal rollback` does not need an image, it needs a **container**: it boots the stopped
`<service>-<role>-<version>` container a previous deploy left behind. `clean` runs
`kamal prune all` at the end of every deploy, which keeps the newest `retain_containers`
stopped containers (config/deploy.yml; Kamal's default is 5) and every image one of them uses,
and removes the rest. So the window is that many previous versions, not one.

After pruning, `clean` lists what is left and fails the deploy if the version it replaced is
gone — the stage entry carries `rollbackWindow`. `shipkit rollback` reads the same list and
says how many versions it could go back to.

Before the kit checked, it looked for an image by `registry` from shipkit.yaml — which is not
necessarily the repository Kamal pulled from — and that, rather than pruning, is the likeliest
reason an earlier drill found versions "not on the server any more". This has not been
re-confirmed against a server.

`kamal rollback` to a version with no container **exits 0 and changes nothing**, so the kit asks
the server first and refuses with the reason:

```
FAILED  sha-68b1faa is not on the server any more (2 version(s) available: sha-47388f5, sha-1c0ffee)
next: Kamal keeps the newest retain_containers stopped containers (config/deploy.yml, default 5)
      and prunes the rest. Deploy that commit again instead — it is still in the registry.
```

That advice is the real recovery path in most cases: the image is still in the registry, and
deploying that commit again goes through the gates rather than around them. It is slower and it
is honest.

## How a rollback is proven

The rollback ends with the same `verify` a release does: the tag it put back must be what
`/health` reports, and the readiness path must answer 200, retried for up to `verifyTimeout`
seconds. The automatic rollback inside a deploy runs it too. When the rollback fails, the deploy
reports both failures — the verify that triggered it first, because that is why production is
in this state — and exits 1.

## What has and has not been exercised

Refusals have been run against a production server: a tag the pipeline never minted, a version
already serving, a version pruned from the host, and a missing argument. **A successful rollback
has not yet been performed end to end.** Until it has, treat this page as a plan rather than a
procedure — see the note in `m6-deploy-scenarios.md`.

## What a rollback does not do

**It does not roll back the database.** Application rollback and database rollback are
separate concerns (ADR 0005). The previous image will be running against the migrated
schema, which is exactly why destructive changes are split across releases — an
expand/contract change is safe to roll back through, a single-release column drop is not.

If the schema is the problem:

1. Restore the database from the pre-deploy backup — on the server, in
   `/var/backups/shipkit/<service>/`, named after the deploy's commit; the deploy report's
   `backup.path` names the exact file (`docs/runbooks/restore.md`), or
2. Ship a corrective migration and deploy forward.

Never write a `Down` migration for production recovery.
