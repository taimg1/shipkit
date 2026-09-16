# Bootstrap a server

The pipeline deploys to a prepared server. It will not install Docker, create users, or open
ports — a deploy that provisions the host is a deploy that can break the host, and
`core/server-probe.ts` refuses rather than guess. `server/bootstrap.sh` is what prepares it.

Target: a bare Ubuntu LTS server you can reach as root.

## Why two phases

The dangerous half of hardening a server is the half that closes the door you are standing in.
So `prepare` does everything that cannot lock anyone out, and `harden` — the phase that turns
passwords off — refuses to run until sshd has actually accepted a key login for the deploy user.

Not "is there an authorized_keys file". Keys get installed with a typo, under the wrong user,
with the wrong permissions, and all of those look like success. The only proof that a door
opens is having opened it.

## 1. A key for the pipeline, not yours

```bash
ssh-keygen -t ed25519 -N '' -C 'shipkit deploy' -f ~/.ssh/shipkit_deploy
```

No passphrase: CI cannot type one. This key is not your admin key. Its private half goes into
`SHIPKIT_SSH_KEY` in the repository's secrets and nowhere else; if it leaks you rotate one key
and keep your own.

## 2. prepare

```bash
ssh root@HOST 'bash -s' -- prepare --key "$(cat ~/.ssh/shipkit_deploy.pub)" < server/bootstrap.sh
```

| | |
|---|---|
| `deploy` user | no password at all, so the key is the only way in |
| Docker | from Docker's own apt repository, with log rotation (10m x 3) |
| docker group | `deploy` joins it — see the warning below |
| firewall | ufw, incoming denied except 22, 80, 443 |
| swap | 2G if the server has none |
| updates | unattended security upgrades, daily |
| clock | UTC, NTP on |

Options: `--user`, `--ssh-port`, `--swap`. Running it twice changes nothing the second time.

**The docker group is root-equivalent.** Anyone who can start a container can mount the host's
filesystem. Kamal requires it, so `deploy` has it, and it is written here rather than pretended
away: treat that key as a root key.

**ufw does not contain Docker.** A container published with `-p` writes its own iptables rules
and is reachable whatever ufw says. The kit's accessories publish nothing — the database is on
Kamal's private network only. Keep it that way.

## 3. Prove the key works

From your workstation, not from the server:

```bash
ssh -i ~/.ssh/shipkit_deploy deploy@HOST 'docker info >/dev/null && echo ok'
```

If this does not print `ok`, stop. Fix it while the password door is still open.

## 4. harden

```bash
ssh root@HOST 'bash -s' -- harden < server/bootstrap.sh
```

Refuses with exit 1 if no key login for `deploy` was ever recorded, or if `deploy` cannot use
Docker. Otherwise it writes `/etc/ssh/sshd_config.d/00-shipkit.conf`:

- `PasswordAuthentication no`, `KbdInteractiveAuthentication no`
- `PermitRootLogin prohibit-password` — root stays reachable **by key**, for the day the deploy
  key has to be replaced. It is the password door that closes, not the last way back in.

The `00-` prefix is not decoration. Cloud-init ships `50-cloud-init.conf` with
`PasswordAuthentication yes`, sshd takes the *first* value it obtains for a keyword, and the
drop-ins are read in name order. A `99-` file would lose silently.

The config is validated with `sshd -t` before the reload, and removed again if it fails. Your
current session stays open either way — open a new one and check before closing the old one.

## Checking later

```bash
ssh root@HOST 'bash -s' -- check < server/bootstrap.sh
```

Prints the deploy user's groups, whether `deploy` can reach Docker, swap, firewall, the two
sshd settings, and whether a key login has been seen.

## What this does not do

Application configuration. No database, no TLS, no DNS: `kamal-proxy` gets the certificate on
the first deploy, and the database accessory is booted by the deploy's `provision` stage
(`shipkit deploy --plan` lists it before anything runs).

Nor off-site backups. A backup that lives on the server it protects is not a backup — see
`docs/runbooks/restore.md`.
