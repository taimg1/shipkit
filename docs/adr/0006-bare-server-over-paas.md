# 0006 — Bare server plus Kamal, not PaaS

Status: accepted · 2026-09-11

## Context

Three delivery variants were considered. The `ci` stage is identical in all three; only
delivery differs.

| | A — bare server | B — PaaS | B1 — PaaS, quick |
|---|---|---|---|
| Pipeline logic | Dagger | Dagger | Plain GitHub Actions YAML |
| Runs locally | yes | yes | no (partially, via `act`) |
| Callable from another app | yes | yes | no |
| Delivery | Kamal | platform's own deploy | platform's own deploy |
| Server prep | required | none | none |
| Monthly cost | fixed, per server | per service, per client | per service, per client |
| Use when | projects you maintain | backend already on a PaaS | one-off handover projects |

## Decision

Variant **A** — bare server with Kamal (MIT) — for projects that are delivered and then
maintained. Free/open-source throughout, fixed cost per server, no platform lock-in.

One-time server preparation, once per server: cloud-init (non-root user, SSH keys only,
password login disabled, firewall allowing 22/80/443, fail2ban, unattended security upgrades,
Docker); `kamal setup`; PostgreSQL in a container with a named volume or the provider's
managed service, never on an ephemeral filesystem; TLS via kamal-proxy with Let's Encrypt;
scheduled `pg_dump` copied off the server; a manual restore drill; Uptime Kuma on separate
infrastructure.

## Consequences

- **Do not run two delivery models at the same time.** Supporting both means doing every
  operational task twice per client.
- Secrets are never committed; they are injected via Kamal secrets / the CI secret store.
  Per-client GitHub accounts mean per-client secret stores — document where each project's
  secrets live, because this is the part that rots first.
- If the PaaS route is ever taken: free tiers are not viable for client work. Services that
  sleep after ~15 minutes of inactivity wake in roughly a minute, and free PostgreSQL
  instances are typically size-capped and time-limited, deleted after the window expires,
  with no backups. Static-host free tiers frequently prohibit commercial use, which includes
  work done for a paying client — check the terms before putting a client on one.
