# 0002 — Dagger (TypeScript SDK) holds the pipeline logic

Status: accepted · 2026-09-11

## Context

Layer 1 of [0001](0001-three-layer-pipeline.md) needs a runner that executes the same
way locally and in CI, is callable from another application, and costs nothing.

## Decision

Dagger, TypeScript SDK. Apache 2.0. Dagger Cloud is paid and is not required.

## Alternatives rejected

- **Jenkins** — JVM plus a plugin architecture; poor fit for container-first pipelines.
- **Drone** — licence restrictions after acquisition. Woodpecker is the fork to use if
  a self-hosted trigger is ever needed, but that is layer 2, not layer 1.
- **Plain GitHub Actions YAML** — does not run locally (only partially, via `act`), is not
  callable from another app, and welds layer 1 to layer 2. Acceptable only for one-off
  handover projects (variant B1 in the plan).
- **A custom TUI for pipeline output** — Dagger already reports per-step timings. A pretty
  progress renderer is the easy part of CI and provides none of the value, which is
  isolated reproducible execution on every push.

## Consequences

- Containerised execution means the pipeline behaves the same on a laptop and on a runner.
- GitHub Actions free minutes on private repos are a soft limit; a self-hosted runner
  removes it entirely without touching pipeline code.
