# What is verified, and what is still a guess

This file exists to be the one place that does not flatter the kit. Everything below is
either something that was run and observed, or something nobody has done yet — and the
second list is the useful one.

A note on how it went wrong before: this document was overwritten with a copy of
`v1-plan.md` in September 2026 and stayed that way for days, while `README.md` kept pointing
readers here for the truth. A status file that duplicates a plan says what was intended, not
what happened. If you find the two agreeing word for word again, this one is the lie.

Last revised 2026-09-23.

## Verified — run, watched, and reproducible

**`ci` for .NET.** `pre`, `build`, `test` against a real PostgreSQL, the `db` gate, and the
publish decision. Exercised continuously on `fixtures/dotnet-api` and, since 2026-09-21, on a
real project (`easytransfer-api`) through GitHub Actions.

**`ci` for Next.** The same pipeline on `fixtures/next-app`: `npm ci`, eslint and `tsc`, a
vitest run, an image built for the target architecture. The `db` stage skips visibly with
`db=none` rather than disappearing.

**`e2e`.** The stage serves the image `build` produced, binds the services the suite declares,
and runs the project's own Playwright against it. Proven in both directions on the fixture:
green on 2 of 2 tests against a seeded Postgres, and red — with the stage failing and the
stages after it skipped — for a wrong assertion and for a run that discovers no tests.

**Deploy, end to end, against `dev-server`** for both stacks, including the failures that
matter: a migration that fails leaves production serving and the schema untouched; a release
whose `/health` reports the wrong version fails `verify` and is rolled back automatically, and
the rolled-back version is itself verified; a second deploy is refused while the first holds
the server-side lock; an image that was never published stops the run before the backup; a
host key that does not match the pin stops it before anything connects.

**Deploy against production**, `easytransfer-api` on a bare server at Hosting Ukraine: by hand
on 2026-09-21, and unattended on a merge to `main` on 2026-09-22 — plan self-approved, backup
taken and stored, migration stage run, release, verify, clean, and a GitHub deployment record
whose state came from the kit's report. The Next site deployed through the kit twice the same
day, with `backup` and `migrate` skipped as `db=none`.

**The backup gate.** A dump is taken before every migration, restored into a scratch database
and compared against production's table count; it is stored on the server under
`/var/backups/shipkit/<service>/` with a digest, and retention prunes the older ones. If it
cannot be stored, `migrate` does not run.

**Publishing to a registry that wants credentials.** Proven against a private registry, and in
production against GHCR from Actions. The digest in the report is the digest the registry
holds.

**Host-key pinning**, for both the kit's own SSH and Kamal's: a wrong key is refused by both.

**Restoring a production backup.** Drilled on 2026-09-22: a dump production wrote was restored
into a scratch container beside the live database — `pg_restore` exited 0 in 0.261 s, and the
result matched production row for row (17 tables, 190 rows, identical migration history). The
restore into the live database itself has not been done, deliberately. `docs/runbooks/restore.md`
records the drill and the four defects it found in the runbook.

**Monitoring.** Uptime Kuma runs on the test server, a different machine from the one it
watches, and checks both production endpoints and their certificates. Alerts go to Telegram.
Separately, a status hub on the same server takes a snapshot from each watched machine every
minute and answers `/status`, `/load`, `/deploys` and `/backups` in Telegram, and reports a
machine that goes silent. The chat round trip and the silence alert were both observed on
2026-09-23 — with the test server as the only watched machine so far.

## Not verified — no one has done this

**Rollback on a real server.** Automatic rollback has fired on `dev-server` and was watched.
On production it has never been needed and never been rehearsed.

**Production in the status hub.** Production does not report to the hub yet, so `/load` and
`/backups` for it do not exist.

**A Kuma alert arriving in the chat.** Kuma raised the alert; that the message landed has not
been confirmed from the chat side.

**Monitoring's own failure.** Kuma and the hub share one server. If it goes down with
production, nothing says so.

## Not implemented — the documents say otherwise in places

- **Off-site backups.** ADR 0004 and `ci-cd-plan.md` §8 state as a rule that backups are
  copied off the server. They are not. The only copy of a dump lives on the machine it exists
  to rescue, and dumps are taken only during a deploy, never on a schedule.
- **`fromHealth`** for an e2e service: parsed and validated, refused at runtime with exit 5.
- **`shipkit init` and `shipkit status`.** Referenced in `docs/cli-design.md`; a new project is
  still wired up by copying files.
- **`delivery: static`.** Refused at config load (exit 5) rather than silently accepted.
- **The Nest adapter and `custom`.** Planned in `docs/multi-stack-plan.md` §7.
- **A deploy key narrower than root, on production.** `server/bootstrap.sh restrict` limits the
  key to the commands the kit actually sends (`docs/runbooks/deploy-key.md`); it has been
  applied and exercised on the test server only. On production the key is still unrestricted,
  and since `deploy` is in the docker group, anyone who can run a workflow there has the
  equivalent of root. Restricting it needs client repositories pinned to a kit with `scp -O`
  first.

## Where to look instead of guessing

- `docs/runbooks/m3-db-gate-scenarios.md` and `m6-deploy-scenarios.md` — the gate and deploy
  scenarios as they were actually run, with output.
- `docs/runbooks/` generally — each runbook says at its head what has been exercised.
- The reports a run writes (`--report`): the only account of a particular deploy that was not
  written by hand.
