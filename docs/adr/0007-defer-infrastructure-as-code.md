# 0007 — OpenTofu is deferred until the hosting target is chosen

Status: deferred · 2026-09-11

## Context

Infrastructure as code is an obvious candidate for a toolkit like this. It is deliberately
not being written yet.

## Decision

Defer it. When it is written, it will be **OpenTofu** (MPL-2.0), not Terraform (BUSL,
IBM-owned).

## Rationale

- It is **not a monitoring tool**. It tracks desired infrastructure state and detects drift
  via `plan`. Server health is Uptime Kuma's job.
- It only manages resources it created or that were explicitly imported. Pointing it at a
  hand-built server shows nothing.
- It is provider-specific. The code for Hetzner, DigitalOcean and a local Ukrainian host have
  nothing in common beyond HCL syntax. **It cannot be written before the hosting decision is
  made.**
- Small local hosting providers often have no OpenTofu provider at all, even when they expose
  a full REST API. In that case this layer becomes scripts, not IaC.
- The state file contains database passwords and keys in plain text. OpenTofu supports
  client-side state encryption; Terraform does not. With one state file per client that matters.

## Revisit when

Several clients share an identical stack — then it is one module plus a variables file per
client. Not before.

## Related

The same principle governs the toolkit itself: build it concretely for two or three real
projects first, and let the differences between those implementations define the parameters.
Designing the generic multi-project utility up front means designing against imagined
requirements.
