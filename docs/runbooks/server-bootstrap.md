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

## 4. Pin the server's host key

`prepare` (and `harden`, and `check`) end by printing the server's ed25519 host key:

```
host key (pin as hostKey in shipkit.yaml; docs/runbooks/server-bootstrap.md)
  fingerprint            SHA256:5kCc5wjjO3Qqwji4vrIROmWSCPd2q9YgX0BqWukHrp4
  known_hosts line       203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
```

That line goes into `shipkit.yaml`, committed, next to the host it belongs to:

```yaml
environments:
  prod:
    host: 203.0.113.10
    sshUser: deploy
    hostKey: "203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
```

Every SSH connection the pipeline makes — its own `ssh`/`scp` and Kamal's — trusts that key
and nothing else (`StrictHostKeyChecking yes`). Without it, every fresh pipeline container
would trust whichever server answered first, and a man in the middle would be handed a
docker-group session, a production dump and the database password. A `host` without a
`hostKey` is a configuration error.

Rules for the line:

- **Its host part is how ssh will look the server up**: the `host` value exactly, and
  `[host]:port` when `sshPort` is not 22 (`[203.0.113.10]:2222 ssh-ed25519 ...`). `bootstrap.sh`
  prints it with the server's first IP and the port `harden` sets; if `shipkit.yaml` uses a
  name, put the name there. `shipkit doctor` checks it. Kamal connects to the hosts in
  `config/deploy.yml`, so use the same name in both files.
- **Take it from the server's own output, or verify it against it.** `ssh-keyscan -p <port>
  <host>` from a workstation is fine for convenience, but it is answered over the same network
  the pin protects against — compare its fingerprint (`ssh-keygen -lf <file>`) with the one
  printed on the server before committing it. Best seen through the provider's web console:
  the root session you ran `prepare` in is itself an SSH connection whose key was accepted on
  first use, unless the provider showed you its fingerprint.
- Several lines are allowed (a YAML block scalar, `hostKey: |`), e.g. to pin ecdsa or rsa as
  well. Types accepted: `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`, `ssh-rsa`. Hashed
  (`ssh-keygen -H`) lines work.

**When the server is rebuilt or its keys are regenerated**, every deploy refuses until the new
key is pinned. That is the point. Get the new fingerprint from the server, not from the
failing deploy, and change `hostKey` in a reviewed commit.

## 5. harden

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
sshd settings, whether a key login has been seen, and the host key to pin (§4). `check` reads
the port from sshd itself.

## What this does not do

Application configuration. No database, no TLS, no DNS: `kamal-proxy` gets the certificate on
the first deploy, and the database accessory is booted by the deploy's `provision` stage
(`shipkit deploy --plan` lists it before anything runs).

Nor off-site backups. A backup that lives on the server it protects is not a backup — see
`docs/runbooks/restore.md`.
