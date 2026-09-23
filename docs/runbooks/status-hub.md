# Status hub

A Telegram bot on one machine that knows the state of the others. It answers four questions
and volunteers one: a server that stopped reporting.

```
watched server                     hub (testserver, 173.242.58.240)
  shipkit-agent.timer   --ssh-->     forced command: store this snapshot
  once a minute                      /var/lib/shipkit-hub/snapshots/<server>.json
                                     shipkit-hub-bot.service  --long poll-->  Telegram
```

Nothing is pulled and nothing is exposed. The hub never opens a connection to a watched
server, and the bot never listens on a port: long polling is outbound, so the hub needs no
domain, no certificate and no inbound rule. Both facts are the design, not an accident of
the current setup — see "Why it is shaped this way" at the end before changing either.

## The commands

| | |
|---|---|
| `/status` | every server: alive or SILENT, how old its snapshot is, the version it serves |
| `/load <server>` | load, memory, disk, `/health`, every container and its state |
| `/deploys <server>` | the tail of Kamal's audit log on that server |
| `/backups <server>` | the newest dump per service under `/var/backups/shipkit/`, and its age |

The bot answers one chat id and one only. Everything from anywhere else is dropped without a
reply — not refused, because a refusal confirms the bot exists and invites a second try.

## Connecting a new server

Three steps on three machines, in this order. The middle one is on the hub on purpose: an
installer that could also authorise itself would mean the hub trusts whoever can run an
installer.

```bash
# 1. on your workstation — the hub's host key fingerprint, taken from the hub itself
ssh root@173.242.58.240 'ssh-keyscan -t ed25519 localhost 2>/dev/null | ssh-keygen -lf -'

# 2. on the new server — installs the agent, pins that fingerprint, starts the timer
tar -cz hub | ssh root@NEW-SERVER 'mkdir -p /tmp/shipkit-agent-src && tar -xz -C /tmp/shipkit-agent-src'
ssh root@NEW-SERVER 'bash /tmp/shipkit-agent-src/hub/agent-install.sh \
    --name NAME --hub 173.242.58.240 --hub-fingerprint SHA256:... \
    --service SERVICE --health-url http://127.0.0.1:PORT/health'

# 3. on the hub — authorise the key the installer printed
ssh root@173.242.58.240 "shipkit-hub-client add NAME 'ssh-ed25519 AAAA... shipkit-agent NAME'"

# 4. prove it
ssh root@NEW-SERVER 'systemctl start shipkit-agent.service && journalctl -u shipkit-agent -n 5 --no-pager'
ssh root@173.242.58.240 'shipkit-hub-client list'
```

`--name` is the name the bot will use and the name in the authorized_keys line. It is
lowercase letters, digits, dash and underscore, and it is what decides which snapshot that
key may overwrite — there is nothing in a payload that can change it.

Step 2 refuses to install anything if the fingerprint does not match what answers at the hub.
That is a gate, not a warning: treat a mismatch as possible interception and take the
fingerprint from the hub's console rather than from the output that just disagreed with you.

If you skip `--health-url`, `/status` will report "version unknown" for that server forever.
That is correct for a box with no application on it and wrong for one with an application.

## Disconnecting a server

```bash
ssh root@SERVER 'systemctl disable --now shipkit-agent.timer'
ssh root@173.242.58.240 'shipkit-hub-client remove NAME'
```

In that order. Revoking first leaves an agent pushing into a closed door once a minute and
filling its own journal with permission errors.

`remove` drops the snapshot as well as the key. Leaving it would make a server nobody watches
any more look silent forever, and `/status` would keep listing it.

To retire the machine completely, also `rm -rf /etc/shipkit-agent /usr/local/lib/shipkit-agent`
and `systemctl disable shipkit-agent.timer`.

## The silence alert

A snapshot older than three minutes makes a server SILENT. That is two missed pushes plus
slack, so a run that started a few seconds late does not fire it.

It sends **one** message when a server goes quiet and **one** when it comes back. Not one a
minute — the bot remembers what it has already said, in
`/var/lib/shipkit-hub/state/silence.json`. Deleting that file makes it re-announce every
server that is currently silent, once, which is the way to re-arm it if it ever got stuck.

Silence means "no snapshot arrived". It does not mean the server is down: an agent whose key
was revoked, whose clock is wrong, or which cannot reach port 22 on the hub is silent while
serving traffic perfectly. Check the agent before you check the machine.

## When the bot says nothing

Work down this list. Each step tells you whether to stop or carry on.

**1. Is the bot running?**

```bash
ssh root@173.242.58.240 'systemctl status shipkit-hub-bot --no-pager -l | head -20'
ssh root@173.242.58.240 'journalctl -u shipkit-hub-bot -n 40 --no-pager'
```

`Restart=always`, so a crash loop looks like a running service until you read the journal.
`restart counter is at N` with a rising N is a crash loop. The two that have happened:

- `TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing from the environment` — the unit reads
  `/etc/shipkit-hub/telegram.env` as root and hands the values over. Check the *names* in
  that file, not just that it exists.
- `refusing to run: configured chat id is not the one this hub answers` — the chat id in
  that file and the one compiled into `statuslib.ALLOWED_CHAT_ID` disagree. The bot stops
  rather than answering a chat nobody decided it should answer.

**2. Is it the bot, or is it Telegram?** The journal logs a message id for everything it
sends (`/status  -> message 412`). An id means Telegram accepted the message and the problem
is on the reading end — wrong chat, muted, cleared. No id and no error means no command
arrived: the bot drops messages from every other chat id silently, so a message typed in the
wrong chat looks exactly like this.

**3. Are snapshots arriving at all?**

```bash
ssh root@173.242.58.240 'shipkit-hub-client list'
```

`no snapshot yet` for a server that has been connected for a while is an agent problem, not
a bot problem — go to 4. Recent snapshots for everything means the hub is fine.

**4. On the server that is quiet:**

```bash
ssh root@SERVER 'systemctl list-timers shipkit-agent --no-pager; journalctl -u shipkit-agent -n 20 --no-pager'
ssh root@SERVER '/usr/local/lib/shipkit-agent/agent --dry-run | head -c 400'
```

`--dry-run` prints the snapshot and pushes nothing, which separates "cannot collect" from
"cannot deliver". What the delivery failures look like:

| In the journal | What it is |
|---|---|
| `Permission denied (publickey)` | the key was never authorised on the hub, or was revoked. Step 3 of connecting. |
| `Host key verification failed` | the hub's host key is not the pinned one. **Stop.** Do not re-pin from what you just saw; see `docs/runbooks/rotate-a-secret.md`. |
| `Connection timed out` | port 22 on the hub, from that server. `ufw status` on the hub. |
| `rejected: snapshot is not JSON` | the agent and the hub's ingest are different versions. Reinstall both from the same checkout. |

**5. Nothing above.** Take one snapshot by hand and watch both ends:

```bash
ssh root@SERVER 'systemctl start shipkit-agent.service'
ssh root@173.242.58.240 'ls -l --time-style=full-iso /var/lib/shipkit-hub/snapshots/'
```

## What it cannot tell you

It reports what a server said about itself a minute ago. It is not a history, not a graph and
not a check that anything works — Uptime Kuma on the same hub does that
(`docs/runbooks/monitoring.md`), and a green `/health` proved nothing during the restore
drill on 2026-09-12.

A backup that appears in `/backups` is a file with a recent timestamp. It is not a backup
until it has been restored (`docs/runbooks/restore.md`).

## Why it is shaped this way

**SSH, not HTTPS.** There is no domain for the hub, so there is no certificate to get. Each
client holds its own key and the hub authorises it for one dedicated user behind a forced
command that accepts a snapshot on stdin and nothing else — no shell, no pty, no forwarding.
A compromised client can overwrite its own snapshot and nothing more; a compromised hub holds
no key into any client, because it never connects to one.

**The client name comes from the key.** Each authorized_keys line carries the name as an
argument of its forced command, so which snapshot gets written is decided by which key opened
the session. The `server` field inside a payload is overwritten on arrival, which is why it
is written rather than read. Proven on 2026-09-23: a client authorised as `spike-a` sent
`{"server":"spike-b",...}` and asked to run `ingest spike-b`; `spike-b.json` was untouched and
`spike-a.json` came back with `"server": "spike-a"`.

**There is no `ForceCommand` in the sshd drop-in, deliberately.** sshd's own forced command
wins over the one in authorized_keys, and it cannot know which client connected — putting one
there would collapse every client into one snapshot. Tried on 2026-09-23 to be sure: with
`ForceCommand /bin/echo ...` in the `Match User shipkit-hub` block, an authorised push ran
the echo and stored nothing. `/etc/ssh/sshd_config.d/20-shipkit-hub.conf` carries only the
belt-and-braces restrictions.

**Reload sshd, never restart it.** The hub is shared. A restart drops nothing in principle
and everything in practice on the day the new config does not parse; `sshd -t` runs before
every reload for the same reason.

## Files

| On the hub | |
|---|---|
| `/usr/local/lib/shipkit-hub/ingest` | the forced command. Stores one snapshot, argument decides whose. |
| `/usr/local/lib/shipkit-hub/bot` | long polling, the four answers, the silence alert |
| `/usr/local/lib/shipkit-hub/statuslib.py` | every decision either of them makes; `tests/status-hub.test.ts` tests this |
| `/usr/local/bin/shipkit-hub-client` | `add` / `remove` / `list` |
| `/etc/ssh/authorized_keys.d/shipkit-hub` | one line per client, root-owned so the receiving user cannot edit it |
| `/etc/ssh/sshd_config.d/20-shipkit-hub.conf` | the restrictions. Delete it and reload to undo them. |
| `/etc/shipkit-hub/telegram.env` | token and chat id, 0600 root. Never in the repository. |
| `/var/lib/shipkit-hub/snapshots/` | one JSON per server, replaced atomically |
| `/var/lib/shipkit-hub/state/` | the poll offset and what has already been announced |

| On a watched server | |
|---|---|
| `/usr/local/lib/shipkit-agent/agent` | collects and pushes; `--dry-run` prints and sends nothing |
| `/etc/shipkit-agent/agent.env` | hub, name, key paths, health URL |
| `/etc/shipkit-agent/id_ed25519` | this server's key. One per server; never shared. |
| `/etc/shipkit-agent/known_hosts` | the hub's pinned host key |
| `shipkit-agent.timer` | once a minute, `AccuracySec=5s` |
