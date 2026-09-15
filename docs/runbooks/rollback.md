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

## What a rollback does not do

**It does not roll back the database.** Application rollback and database rollback are
separate concerns (ADR 0005). The previous image will be running against the migrated
schema, which is exactly why destructive changes are split across releases — an
expand/contract change is safe to roll back through, a single-release column drop is not.

If the schema is the problem:

1. Restore the database from the pre-deploy backup (`docs/runbooks/restore.md`), or
2. Ship a corrective migration and deploy forward.

Never write a `Down` migration for production recovery.
