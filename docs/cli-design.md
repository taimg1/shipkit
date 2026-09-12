# CLI design — one interface for a human, an agent, and another program

> Agreed 2026-09-12. Formalised in ADR 0009.

## Principle

There is no separate "API for the agent". There is one CLI with three properties that make
it equally usable from a terminal, from Claude Code via Bash, and from another program:

1. **Non-interactive.** Nothing ever blocks on stdin.
2. **Structured output on demand.** `--json` returns the same report the human sees.
3. **Exit codes that mean something.** "The code is bad" and "Docker is not running" are
   different situations requiring different reactions.

`shipkit` is a thin translator to `dagger call`. It holds no pipeline logic — the same rule
that applies to workflow YAML (ADR 0001) applies to it. If logic appears in the wrapper,
it has leaked into the wrong layer.

## Commands

```
shipkit ci                      # pre → build → test → db → push
shipkit ci --stage db           # one stage, for a fast loop
shipkit db lint                 # Squawk on pending migrations only — seconds, not minutes
shipkit db pending              # which migrations are not on main / not on prod
shipkit deploy --plan           # what would happen; exit 0, touches nothing
shipkit deploy --yes=<token>    # execute exactly that plan
shipkit rollback <sha>
shipkit doctor                  # dagger? docker? shipkit.yaml? secrets? ssh?
```

`shipkit status` is deliberately **not** in v1 — it has nothing to report until `deploy`
exists. It arrives with M6.

## The escape hatch

The wrapper must never become the only way in. Two guarantees:

- `shipkit --explain <command>` prints the exact `dagger call …` it would run, and exits.
- `shipkit --raw <args…>` passes everything through to `dagger call` untouched.

So in an emergency — a wrapper bug, a stage that needs a flag the wrapper does not expose,
debugging the module itself — the underlying tool is one word away. Anything `shipkit` can
do, `dagger call` can do; the wrapper only shortens it and normalises the output.

## Exit codes

| Code | Meaning | Typical reaction |
|---|---|---|
| 0 | ok | continue |
| 1 | a gate said no (lint, test, Squawk, verify) | fix the code — this is not a tool failure |
| 2 | configuration (no `shipkit.yaml`, invalid, missing secret) | fix the config |
| 3 | infrastructure (dagger/docker/ssh/registry unreachable) | fix the environment, retry |
| 4 | confirmation required (`deploy` without `--yes`) | show the plan to the human |
| 5 | not implemented in this version | — |

Code 5 was added while prototyping: unimplemented stages must fail closed and be
distinguishable from a real failure. A stage that is not built yet must never return "ok".

## Report shape

```json
{
  "command": "ci", "sha": "a1b2c3d", "ok": false, "seconds": 123,
  "stages": [
    { "name": "pre",  "status": "ok", "seconds": 14 },
    { "name": "test", "status": "ok", "seconds": 48, "tests": { "passed": 112, "failed": 0 } },
    { "name": "db",   "status": "failed", "gate": "squawk",
      "findings": [{ "rule": "require-concurrent-index-creation",
                     "file": "ci/migration.sql", "line": 14,
                     "sql": "CREATE INDEX ix_orders_created_at ON orders (created_at);" }] },
    { "name": "push", "status": "skipped", "reason": "previous stage failed" }
  ],
  "next": "Use CREATE INDEX CONCURRENTLY via migrationBuilder.Sql(..., suppressTransaction: true). See docs/adr/0005."
}
```

The `next` field is the important one. A failure that says *what to do* is fixed in one
pass; a failure that only says "failed" takes three.

Without `--json`, progress is Dagger's own output (we do not write a TUI — `ci-cd-plan.md`
§3) and the wrapper adds only the final stage table and verdict.

Every run writes `.shipkit/runs/<timestamp>-<sha>.json` so that a previous result can be
read without re-running.

## The plan token

`--yes` takes a **plan token**, never a bare `true`:

```
$ shipkit deploy --plan
  target      prod  (api.client.com)
  image       sha-a1b2c3d  ←  currently sha-9f8e7d6
  migrations  20260911_AddOrdersIndex
  sql         CREATE INDEX CONCURRENTLY ... (12 lines, no destructive ops)
  backup      will run first; last verified 2026-09-10 03:00

  to execute: shipkit deploy --yes=7f3a91c2e004
```

The token is a hash over the plan's content — target, image tag, current image tag, the
migration list, and a digest of the SQL. If anything about the plan changes between showing
and executing, the token no longer matches and `deploy` refuses.

Consequences:

- An agent physically cannot deploy something it has not shown the human.
- In a terminal the human copies the line from the output — the same gesture as typing `-y`.
- Another program does `--plan` → inspects → `--yes=<token>`, so confirmation becomes its
  decision rather than a prompt on stdin.

The token proves *"this exact plan was displayed"*, not *"a human approved it"*. Human
approval is a rule on top, carried in `CLAUDE.md` and the shipkit skill:

> Never pass `--yes` without the user approving that exact plan in this conversation.

The intended agent loop:

> user: "deploy" → agent: `deploy --plan`, shows it → user: "ok" → agent:
> `deploy --yes=<token>` → agent reports the result (and the backup path if a rollback fired).

## Claude Code integration

- `.claude/skills/shipkit/SKILL.md` in this repo, installed into client repos by
  `shipkit init` (M7): how to invoke, how to read `--json`, the confirmation protocol, and
  what each exit code means.
- One line in the client repo's `CLAUDE.md`: *Deploy only via `shipkit deploy`. Never pass
  `--yes` without the user approving that exact plan in this conversation.*
