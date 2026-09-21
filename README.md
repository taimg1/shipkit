# shipkit

A reusable CI/CD toolkit for turnkey client projects — .NET, NestJS, Next.js — on PostgreSQL:
build, test against a real PostgreSQL, lint migrations, deploy to a bare server,
verify, roll back.

## Shape

| Layer | What | Tool |
|---|---|---|
| Pipeline logic | lint, build, test, migrate, deploy | Dagger (TypeScript SDK) |
| Trigger | starts the pipeline | GitHub Actions (thin wrapper) |
| Delivery | artifact → server | Kamal |

Each job in the workflow YAML is a checkout and one call. Nothing else. That is what keeps
the pipeline portable to Woodpecker, Gitea Actions or GitLab CI.

One job per stage — Code analysis, Tests, Migrations, then Image, then a summary that renders
every stage report into the run summary and is there precisely when a job failed. `build` and
`push` share the built container in memory, so they are one job (ADR 0001, amendment).

`templates/github/ci.yml` is what a client repository copies, together with
`templates/github/actions/setup/action.yml`, which is how five jobs install one pinned Dagger
and unpack one pinned kit. A project with no database copies `templates/github/ci-no-db.yml`
instead: the same workflow without the Migrations job. Neither template deploys.

## Pipelines

- `dagger call ci` — `pre` → `build` → `test` → `db` → `push`. Runs on every push and PR.
- `dagger call deploy` — `backup` → `migrate` → `release` → `verify` → `rollback` → `clean`.
  Without `--yes` it prints target, image version, pending migrations and the SQL diff,
  then waits for confirmation.
- `shipkit deploy --auto` self-approves only a plan with no destructive SQL, no declared data
  loss and nothing to provision; anything else stops with exit 4, having touched nothing, and
  hands back the plan and the token that executes it. It is what an unattended deploy would run —
  no client template wires one up yet, so a release is a person running `--plan` and then
  `--yes=<token>`. `docs/runbooks/deploy.md`.

## Runbooks

`docs/runbooks/` — deploy, rollback, restore, adding a migration, rotating a secret,
monitoring. Plus records of what the gates actually did when they were driven through their
failure cases.

## Status

**Both pipelines run end to end** against a simulated bare server (`dev-server/`), including
every failure case: a migration that fails, a release that does not take, a rollback, and a
restore from backup. `docs/prototype-status.md` records exactly what is verified and what is
still a guess.

Not yet done: an authenticated registry push, and a real server — TLS, a firewall, and
backups that leave the machine. Both wait on the hosting decision, which is the only thing
blocking anything.

## Docs

- `docs/ci-cd-plan.md` — *why*: the full plan, with the traps that motivated each decision.
- `docs/v1-plan.md` — *now*: milestones M0–M7 for the stable .NET version, with a definition of done each.
- `docs/multi-stack-plan.md` — *later*: what is core vs. per-stack (.NET / NestJS / Next.js) and the adapter seam.
- `docs/adr/` — one decision per file.
- `docs/cli-design.md` — the CLI contract: commands, exit codes, report shape, plan token.
- `docs/prototype-status.md` — what in the prototype is verified, and what is a guess.
- `CLAUDE.md` — the enforceable rules only.
