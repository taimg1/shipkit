# 0009 — A thin `shipkit` CLI wraps `dagger call`, and raw Dagger stays reachable

Status: accepted · 2026-09-12

## Context

The pipeline must be runnable by a human from a terminal and callable programmatically
(`ci-cd-plan.md` §1). `dagger call ci --source=.` already satisfies both, but it is verbose,
its exit code is 1 for everything, and its output is not structured for a caller that needs
to decide what to do next.

## Decision

Ship a thin `shipkit` CLI that translates short commands into `dagger call`, normalises
output (`--json`), and maps failures onto meaningful exit codes (0/1/2/3/4/5).

It contains **no pipeline logic**. Same rule as workflow YAML: logic in the wrapper is
logic in the wrong layer.

Raw Dagger stays a first-class path, permanently:

- `shipkit --explain <cmd>` prints the underlying `dagger call …` and exits.
- `shipkit --raw <args…>` passes through to `dagger call` untouched.

`--yes` takes a plan token (a hash of the displayed plan), not a boolean.

## Consequences

- Two entry points must be kept in sync: every module function is reachable through `--raw`
  by construction, so the risk is only that the wrapper's shortcuts lag behind. Acceptable.
- The wrapper is a place where logic could accumulate. Review rule: if a change to
  `bin/shipkit` is not argument translation, output formatting, or exit-code mapping, it
  belongs in the Dagger module.
- The wrapper needs Node, which is already required by the TypeScript SDK.
- A wrapper bug cannot block a deploy — `--raw` bypasses it.

## Alternatives rejected

- **Raw `dagger call` only** — no exit-code semantics, no normalised report; every caller
  re-implements parsing.
- **A wrapper that hides Dagger entirely** — recreates the lock-in that ADR 0001 exists to
  prevent, one level up.
- **An interactive prompt for deploy confirmation** — blocks on stdin, unusable from another
  program, and pushes the agent toward auto-answering it.
