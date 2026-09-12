# 0001 — Pipeline logic, trigger and delivery are three separate layers

Status: accepted · 2026-09-11

## Context

Repos are private GitHub, with a separate GitHub account per client. GitHub is the
current host, but nothing guarantees it stays that way — a client may end up on Gitea,
GitLab, or self-hosted infrastructure. The pipeline must also be runnable by a human
from a terminal and callable programmatically by another application.

## Decision

Three layers, kept apart:

1. **Pipeline logic** — lint, build, test, migrate, deploy. Lives in the repository, as code.
2. **Trigger** — who starts it. Currently GitHub Actions.
3. **Delivery** — how the artifact reaches the server. Kamal.

The CI YAML file contains a checkout and one call. Nothing else.

## Consequences

- Migrating to Woodpecker, Gitea Actions or GitLab CI means rewriting ~10 lines,
  not rewriting the pipeline.
- The same pipeline runs locally and from another program, because the trigger is not
  where the logic lives.
- Lock-in only ever appears when layer 1 leaks into layer 2, so that leak is the thing
  to police in review.
- If a fallback plain-YAML variant is ever used, both it and the Dagger module must call
  the same commands from one place (scripts or a Taskfile) — two definitions drift apart
  within months.
