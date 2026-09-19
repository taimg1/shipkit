# dev-server — a bare server, simulated

A container that Kamal can deploy to: SSH on port 2222, Docker inside, and a registry it
trusts. It exists so the `deploy` pipeline can be built, run and deliberately broken without
paying for a VPS and before the hosting decision is made.

```bash
cd dev-server
docker compose up -d --build          # first run generates nothing; see below for the key
ssh -i .ssh/id_ed25519 -p 2222 deploy@localhost
docker compose down -v                # removes it completely, including the server's disk
```

The SSH key is generated per machine into `.ssh/` and is gitignored. Create it once:

```bash
ssh-keygen -t ed25519 -N "" -C shipkit-dev-server -f .ssh/id_ed25519
cp .ssh/id_ed25519.pub .ssh/authorized_keys
```

The server's own host key is different: it is fixed and committed in `host-key/`, and
`fixtures/dotnet-api/shipkit.yaml` pins it as `hostKey`
(`SHA256:5kCc5wjjO3Qqwji4vrIROmWSCPd2q9YgX0BqWukHrp4`). The pipeline refuses any server whose
key is not pinned, so a key regenerated on every rebuild would mean re-pinning on every
rebuild. Its private half being in the repository is harmless only because this container is
never anything but a simulation. To connect by hand without trusting it blindly:

```bash
printf '[localhost]:2222 %s\n' "$(cut -d' ' -f1,2 host-key/ssh_host_ed25519_key.pub)" > .ssh/known_hosts
ssh -o UserKnownHostsFile=.ssh/known_hosts -i .ssh/id_ed25519 -p 2222 deploy@localhost
```

## What it proves

Verified 2026-09-12: an image built from `fixtures/dotnet-api` was loaded into the registry,
pulled by the server, started against a PostgreSQL container, and answered
`{"status":"ok","version":"abc1234deadbeef"}` — the SHA baked in at publish. The whole
delivery chain works end to end.

It is a real enough target for the things `deploy` is made of:

- Kamal's `setup`, `deploy`, `rollback` and the zero-downtime container swap
- running a migration bundle on a machine that has no .NET SDK
- `pg_dump`, and restoring that dump into a scratch database to prove it is restorable
- the smoke test, including the case that matters: a 200 from the *previous* container
- destroying the whole thing and rebuilding it, which is the only way a restore drill means
  anything

## What it does not prove

Not weaknesses to fix — things that need a real provider and a public name:

- **TLS via Let's Encrypt.** ACME needs a domain that resolves publicly. kamal-proxy's
  certificate handling is untested here.
- **cloud-init, the firewall, fail2ban, unattended upgrades.** This container has none of
  them and is not hardened in any way.
- **Off-server backups.** A backup that lives on the machine it backs up is not a backup, and
  here there is nowhere else to put it.
- **Anything provider-specific**: block storage, private networking, managed PostgreSQL,
  snapshots.
- **Real latency, real disk, real failure.** Everything here is local and fast.

So `deploy` can be finished against this, and the parts of §8 that concern the actual machine
still wait for the hosting decision.

## Why it is shaped this way

`privileged: true` is required for Docker-in-Docker, and root logs in with a key sitting in a
working tree. Both are fine for something that is destroyed with `docker compose down -v`,
and both are the reason this must never be pointed at anything real.

The registry is here because Kamal pulls images rather than receiving them. Dagger will not
speak HTTP to a registry, and there is no credentialled one locally, so `load-image.sh` takes
the back way in: save on the host, load on the server, push from there to the registry the
server already trusts. That script is scaffolding — nothing in the kit depends on it.
