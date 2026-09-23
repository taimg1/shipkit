# Monitoring

Uptime Kuma is in service on the test server. This is the procedure for what exists, not a
starting point — the "first run" flow below only applies if the instance is ever rebuilt.

## Where it runs

**Not on the server it watches.** Kuma runs on the test server (`testserver`, 173.242.58.240),
watching production's (173.242.57.83) public HTTPS endpoints over the internet. When the
production machine is gone, the monitor watching it is still up, on separate infrastructure —
that's the whole point of putting it there instead of on production itself. See ADR 0004.

Deployed at `/opt/shipkit-monitoring/docker-compose.yml` on testserver, from
`monitoring/docker-compose.testserver.yml` in this repo (same pinned image/digest as the local
rehearsal file, port bound to `127.0.0.1` only, no `extra_hosts`). Kuma's state — the admin
account and every monitor — lives entirely in the `shipkit-monitoring_kuma-data` Docker volume
on that server. Nothing backs it up; rebuilding the container loses the config, not the data
being watched.

`monitoring/docker-compose.yml` (no `.testserver` suffix) is unchanged and still what it always
was: a local rehearsal against `dev-server`, good for checking that a compose file is well-formed,
not a second real instance.

## How to reach it

The UI is bound to `127.0.0.1:3001` on testserver, not exposed to the internet. Kuma hands
whoever loads its setup page first a live admin account, so it must never be reachable before
one exists — it was given one immediately after the container first came up, before opening it
to anyone. Docker publishes ports via its own iptables rules, which bypass `ufw` for anything
bound to `0.0.0.0`, so binding to `127.0.0.1` is the actual control; `ufw`'s default-deny is
belt and suspenders, not the reason this is safe.

Open it through an SSH tunnel:

```bash
ssh -N -L 13001:127.0.0.1:3001 testserver
# then open http://localhost:13001
```

Add `-f` to run the tunnel in the background instead of holding a terminal open.

Admin credentials (`shipkit-ops`) were generated during setup and are not in this repo. Get
them from whoever stood the instance up, or reset them from the server if lost — Kuma has no
self-service recovery, so a lost password means editing the SQLite/DB record directly or
recreating the account by clearing the data volume (which also deletes every monitor).

## What is watched, and why

| Monitor | URL | Interval | Retries | Why |
|---|---|---|---|---|
| Liveness | `https://api.easytransfer.com.ua/health` | 60s | 2 | separates "the app is down" from "the database is down" |
| Readiness | `https://api.easytransfer.com.ua/health/ready` | 60s | 2 | 200 only when the app can reach its database |
| Site | `https://easytransfer.com.ua` | 60s | 2 | the thing a user actually hits |
| TLS expiry | both hostnames above | — | — | Let's Encrypt renews on its own until the day it does not |

60 seconds and 2 retries (3 failed checks, ~3 minutes) matches what this runbook already
recommended before anything existed to configure: fast enough to catch an outage promptly,
loose enough that one dropped packet doesn't page anyone.

Watching `/health` alone is not enough, and this is not theoretical: during the restore drill
on 2026-09-12 the production schema was dropped entirely, and `/health` kept answering 200
throughout while the application could serve nothing. It reports the running version and
touches no dependency, which makes it useless as an alarm. Readiness is the one that would
have caught it.

The deploy gate uses both, but only at deploy time: `verify` requires the new version on
`/health` **and** a 200 from the readiness path (`ready:` in shipkit.yaml) before a release
counts, retrying either for up to `verifyTimeout` seconds (default 60). Kuma is what watches
both continuously, between deploys.

TLS expiry is not a separate monitor — Kuma reads certificate info on every HTTPS check and
Uptime Kuma 1.23's per-monitor `expiryNotification` switch is on for all three monitors above.
There is no per-monitor expiry threshold in this version; the warning window is a global
setting (`tlsExpiryNotifyDays`, currently at Kuma's default of 7/14/21 days out) rather than
something tuned per host.

## Where alerts go

One notification, **Telegram — shipkit ops**, is attached to every monitor and marked default,
so a monitor added later gets it too. It posts to the operator's private chat through the same
bot the status hub answers from ([status-hub](status-hub.md)); the token lives in Kuma's own
database, not in this repository.

Exercised on 2026-09-23 with a probe monitor pointed at a port nothing listens on: Kuma marked
it DOWN as important, which is the event that triggers a send, and the probe was then deleted.
That the message reached the chat has not yet been confirmed from the chat side.

To change the destination: UI (tunnel above) → **Settings → Notifications**, edit the entry,
press **Test**, and confirm the message actually lands — a notification that is configured
but never fired is not verified. If a new one replaces it, tick **Apply on all existing
monitors** when saving.

## What it cannot tell you

Kuma answers "is it responding". It does not answer "is it correct", "is it slow for this
one client", or "did last night's backup actually run". Backups in particular fail quietly:
check the bucket, and rehearse a restore (`docs/runbooks/restore.md`) rather than trusting
that a file appearing means anything.

It also cannot tell you anything if the Telegram token is revoked without being replaced, or
if the test server it runs on goes down at the same moment as production — a second, independent
failure this setup doesn't defend against.
