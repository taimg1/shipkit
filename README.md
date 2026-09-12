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

The workflow YAML contains a checkout and one call. Nothing else. That is what keeps
the pipeline portable to Woodpecker, Gitea Actions or GitLab CI.

## Pipelines

- `dagger call ci` — `pre` → `build` → `test` → `db` → `push`. Runs on every push and PR.
- `dagger call deploy` — `backup` → `migrate` → `release` → `verify` → `rollback` → `clean`.
  Without `--yes` it prints target, image version, pending migrations and the SQL diff,
  then waits for confirmation.

## Status

**Prototype (M0).** The module skeleton, the adapter seam and the CLI wrapper exist and have
never been executed against a real Dagger engine — see `docs/prototype-status.md` for exactly
what is verified and what is not. `docs/v1-plan.md` is the build order.

## Docs

- `docs/ci-cd-plan.md` — *why*: the full plan, with the traps that motivated each decision.
- `docs/v1-plan.md` — *now*: milestones M0–M7 for the stable .NET version, with a definition of done each.
- `docs/multi-stack-plan.md` — *later*: what is core vs. per-stack (.NET / NestJS / Next.js) and the adapter seam.
- `docs/adr/` — one decision per file.
- `docs/cli-design.md` — the CLI contract: commands, exit codes, report shape, plan token.
- `docs/prototype-status.md` — what in the prototype is verified, and what is a guess.
- `CLAUDE.md` — the enforceable rules only.
