# hub — the status hub

A push-based status hub and the Telegram bot that queries it. Operating instructions are
`docs/runbooks/status-hub.md`; this file is what the code is and why it is written this way.

```
hub-install.sh    on the hub: two users, the ingest door, the bot unit
hub-client.sh     on the hub: add / remove / list the clients allowed to push
ingest.py         the forced command behind every client key
bot.py            long polling, four commands, the silence alert
statuslib.py      every decision the other two make — tested by tests/status-hub.test.ts
agent-install.sh  on a watched server: key, pinned hub host key, timer
agent.py          collects one snapshot and pushes it
systemd/          the three units
```

**bash and python3 standard library, nothing else.** A watched server is a client's
production box. Adding a package to it to watch it is a change to the thing being watched,
and it is a change that has to be made again on every server and undone on every rebuild.
Ubuntu has both of these already.

**The logic is in `statuslib.py`, not in the bot.** `bot.py` talks to Telegram and `ingest.py`
talks to sshd, and neither is reachable from a test. What is worth getting right — which
payload is accepted, whose snapshot it becomes, when a server counts as silent, what an
answer says — is in the one module that is, and `tests/status-hub.test.ts` drives it directly.

**The hub is not one of the watched servers in principle**, though at the moment it is also
watching itself. When the machine is gone, so is anything running on it, including the thing
that was supposed to notice — the same reason `docs/runbooks/monitoring.md` gives for where
Uptime Kuma runs.
