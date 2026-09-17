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

## Amendment — 2026-09-17: one call per stage, not one call per run

"A checkout and one call" was read as one *job*, and it cost the reader everything the run
page could have told them: a single box, green or red, with the stage that failed, the time
each took and what a gate said all buried in a log.

The rule is now per job. `ci.yml` runs one job per stage — `analysis`, `tests`, `migrations`,
`image` — and each is still a checkout and one `shipkit ci --stage=...`. No decision moved
into YAML: which stages exist, what they do and whether they passed are all still the module's.

Two consequences worth stating:

- Each job is a fresh runner with a cold Dagger cache, so total machine time went up. The
  three checks run in parallel, which buys most of the wall clock back.
- `build` and `push` share the built container in memory. Split across runners, `push` finds
  no image and skips itself — a green run that published nothing. They stay in one job, which
  is why `--stage` takes a list.

A final `summary` job renders the stage reports into `$GITHUB_STEP_SUMMARY`. That is output
formatting, so it lives in the wrapper (ADR 0009), not in the module and not in YAML.
