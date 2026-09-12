# 0008 — Stack-specific logic lives behind one adapter interface; the core never branches on stack

Status: proposed · 2026-09-11 · to be confirmed at step 3 of `docs/multi-stack-plan.md`

## Context

The kit was planned for .NET + EF Core. Client projects will also be NestJS and Next.js.
Forking the kit per stack means every gate, every fix and every server-prep change is done
three times. Templating everything into one generic pipeline up front means designing
against requirements that do not exist yet — which the original plan (§9) explicitly warns
against.

## Decision

- The pipeline shape, the gates, tagging, confirmation, delivery, backup, verify and
  rollback are **core**, written once.
- Everything that differs by language or ORM — restore, lint, build (the Dockerfile),
  test runner, migration SQL generation, migration apply — is a **stack adapter**
  implementing one TypeScript interface (`docs/multi-stack-plan.md` §3).
- The core selects an adapter from `shipkit.yaml` in the client repo and never inspects the
  stack name after that.
- A `custom` adapter delegating to Taskfile targets is the escape hatch for unknown stacks.
  It is written last.

## Why "proposed" and not "accepted"

Because the interface in §3 is a guess made with one implementation. It becomes accepted
when the NestJS adapter is written and the .NET adapter still passes — that is the moment
two concrete implementations define the seam. If the interface has to change shape in a
way §3 did not anticipate, this ADR is superseded, not edited.

## Consequences

- The .NET adapter must be written against the interface from day one, with the checklist
  in `docs/multi-stack-plan.md` §8 enforced in review. Otherwise step 3 is a rewrite.
- The `db` stage contract is "plain SQL in, apply-artifact out". ORMs whose migrations are
  not plain SQL (TypeORM, MikroORM) get a weaker gate via `custom`, by design.
- Client projects owe the kit two conventions: `/health` reporting the running SHA, and
  `shipkit.yaml` at the root. The kit owes them nothing stack-shaped in return.
- Dagger, Kamal, PostgreSQL and Docker are *not* abstracted. They are the fixed points the
  adapters vary around.

## Alternatives rejected

- **One kit per stack** — three copies of the gates is three places for a gate to fail open.
- **Convention-only (every repo implements Taskfile targets, no adapters)** — maximally
  universal and maximally drifty; every client repo becomes a partial reimplementation of
  the kit. Kept only as the `custom` escape hatch.
- **Fully generic config-driven pipeline (YAML describes every stage)** — that is a CI
  system, not a kit; it recreates the workflow-YAML lock-in one level up.
