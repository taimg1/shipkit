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

One job per stage — Code analysis, Tests, Migrations, then Image, then E2E, then Deploy, plus a
summary that renders every stage report into the run summary and is there precisely when a job
failed. `build` and `push` share the built container in memory, so they are one job (ADR 0001,
amendment).

`templates/github/ci.yml` is what a client repository copies, together with
`templates/github/actions/setup/action.yml`, which is how seven jobs install one pinned Dagger
and unpack one pinned kit. A project with no database copies `templates/github/ci-no-db.yml`
instead: the same workflow without the Migrations job and without the production connection
string.

The `E2E` job drives the project's own browser suite against the image that was just built,
with whatever services the `e2e:` block in shipkit.yaml declares started beside it. The `Deploy`
job waits for it: a browser suite that reports after the release is a report, not a gate. A
project with no `e2e:` block gets a stage that skips with "not configured" rather than a green
row that suggests coverage it does not have — `docs/runbooks/e2e.md`, which also says which check
to write first and why it is not this one.

The `Deploy` job runs only on a push to the default branch, one at a time and never cancelled
mid-migration, and it is the only job that sees the deploy key. It calls `shipkit deploy
--auto` and records the result as a GitHub deployment whose state comes from the kit's report
— not from whether the job reached its last step. Turning it on takes four things:
"Before you turn the deploy job on" in `docs/runbooks/deploy.md`, and the fourth of them is
running the first deploy by hand.

## Pipelines

- `dagger call ci` — `pre` → `build` → `test` → `e2e` → `db` → `push`. Runs on every push and
  PR. `e2e` serves the image `build` just produced, starts whatever the browser tests need, and
  runs the project's own suite against it; with no `e2e:` block in shipkit.yaml it is skipped
  with that reason and costs nothing.
- `dagger call deploy` — `backup` → `migrate` → `release` → `verify` → `rollback` → `clean`.
  Without `--yes` it prints target, image version, pending migrations and the SQL diff,
  then waits for confirmation.
- `shipkit deploy --auto` self-approves only a plan with no destructive SQL, no declared data
  loss and nothing to provision; anything else stops with exit 4, having touched nothing, and
  hands back the plan and the token that executes it. It is what the client templates' `Deploy`
  job runs on a merge to the default branch. A stopped deploy is finished by a person:
  `--plan`, read it, then `--yes=<token>`. `docs/runbooks/deploy.md`.

## Runbooks

`docs/runbooks/` — deploy, rollback, restore, adding a migration, the browser suite, rotating a
secret, monitoring. Plus records of what the gates actually did when they were driven through their
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
- `docs/multi-stack-plan.md` — *later*: what is core vs. per-stack (.NET / NestJS / Next.js) and the adapter seam. Two stacks are implemented: `dotnet` and `next`.
- `docs/adr/` — one decision per file.
- `docs/cli-design.md` — the CLI contract: commands, exit codes, report shape, plan token.
- `docs/prototype-status.md` — what in the prototype is verified, and what is a guess.
- `CLAUDE.md` — the enforceable rules only.
