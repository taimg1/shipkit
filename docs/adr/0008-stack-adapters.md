# 0008 — Stack-specific logic lives behind one adapter interface; the core never branches on stack

Status: accepted · proposed 2026-09-11, confirmed 2026-09-21 by the second adapter

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

## What confirmed it

The interface in §3 was a guess made with one implementation. The condition for accepting it
was a second adapter with the first still passing. That second adapter is **Next.js**, not
NestJS — `docs/multi-stack-plan.md` §10 left steps 3 and 4 free to swap, and the Next.js
project that needs the kit exists while a NestJS one does not.

The seam held. What moved was smaller than a reshape, and is recorded in §7 of that document:

- What a stack requires of `shipkit.yaml` turned out to be part of the seam, not part of the
  core. `project` and `migrationsProject` are `dotnet ef` arguments that every project was
  made to supply; `stackVersion` had a single meaning. They are now a per-stack table in
  `adapters/requirements.ts`, which config looks up — config is still validated before an
  adapter is chosen, so the table is data, not an adapter call.
- An adapter without a `DbAdapter` had to become a refusal in config. The core skips the db
  stage when there is none, so `stack: next` with `db: postgres` would have skipped the
  migration gates rather than run them (ADR 0004).
- `parseTestSummary` had to separate "the runner found no tests" from "the output could not
  be read".

One caveat, stated plainly: the **`DbAdapter` half of the seam is still defined by one
implementation.** Next.js is `db: none`. Step 3 (NestJS + Prisma) remains the test of the
database seam, and this ADR's confirmation does not extend to it.

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
