# Runbooks

Written to be read when something is wrong, by someone who did not build this.

| Runbook | When |
|---|---|
| [deploy](deploy.md) | shipping a change |
| [rollback](rollback.md) | the change was wrong and the gates let it through |
| [restore](restore.md) | the database needs to come back — includes the drill and its date |
| [add-a-migration](add-a-migration.md) | before writing one, not after a gate refuses it |
| [rotate-a-secret](rotate-a-secret.md) | a key or password changes |
| [monitoring](monitoring.md) | setting up Uptime Kuma, and what it cannot tell you |

Records of what the pipeline actually did, kept as evidence rather than instruction:

- [m3-db-gate-scenarios](m3-db-gate-scenarios.md) — the seven `db` gate scenarios, and the
  measurement the whole linting gate rests on
- [m6-deploy-scenarios](m6-deploy-scenarios.md) — the three deploy scenarios, including the
  rollback that was broken until a deploy was made to fail on purpose
