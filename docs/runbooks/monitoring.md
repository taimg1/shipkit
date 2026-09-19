# Monitoring

```bash
cd monitoring && docker compose up -d      # then open http://localhost:3001
```

First run asks for an admin account. There is no configuration file to commit — Kuma keeps
its state in a volume — so what a new instance needs is written down here instead.

## Where it runs

**Not on the server it watches.** When the machine is gone, so is anything running on it,
including the thing that was supposed to notice. A different provider is better than a
different machine at the same one.

## What to watch

| Monitor | URL | Why |
|---|---|---|
| Readiness | `https://<app>/health/ready` | 200 only when the app can reach its database |
| Liveness | `https://<app>/health` | separates "the app is down" from "the database is down" |
| TLS expiry | the same host | Let's Encrypt renews on its own until the day it does not |

Watching `/health` alone is not enough, and this is not theoretical: during the restore drill
on 2026-09-12 the production schema was dropped entirely, and `/health` kept answering 200
throughout while the application could serve nothing. It reports the running version and
touches no dependency, which makes it useless as an alarm.

The deploy gate uses both. `verify` requires the new version on `/health` **and** a 200 from
the readiness path (`ready:` in shipkit.yaml) before a release counts, and retries either for up
to `verifyTimeout` seconds (default 60). Before that, a release that could not reach its database
passed `verify` as long as it reported the right version. Monitoring is still needed: `verify`
looks once, at deploy time.

Suggested settings: 60s interval, 2 retries before alerting, and a notification channel that
reaches someone who is not looking at a dashboard.

## What it cannot tell you

Kuma answers "is it responding". It does not answer "is it correct", "is it slow for this
one client", or "did last night's backup actually run". Backups in particular fail quietly:
check the bucket, and rehearse a restore (`docs/runbooks/restore.md`) rather than trusting
that a file appearing means anything.
