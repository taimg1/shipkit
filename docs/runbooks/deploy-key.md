# The deploy key, and what it is allowed to do

The private half of the deploy key lives in the repository's secret store. Everyone who can
start a workflow can therefore open an SSH session as `deploy`, and `deploy` is in the docker
group, which is root on the machine. That is not a bug in the kit — Kamal requires the docker
group — but it does mean the key is a root key unless something stops it being one.

`server/bootstrap.sh restrict` is that something. This runbook is what to read when it refuses
a deploy at three in the morning.

## What the key may do

Behind the restriction, one SSH session can do exactly four kinds of thing.

| Channel | How it arrives | Rule |
|---|---|---|
| shipkit's own commands | `SSH_ORIGINAL_COMMAND` is the bare word `sh`, the script on stdin | allow-list of known script shapes — **default deny** |
| the two uploads | `scp -t <path>` | destination must be a backup file or a migration bundle; downloads refused |
| Kamal | its own command, whatever `config/deploy.yml` produced | deny-list of escalation arguments — **default allow** |
| an interactive shell | no command at all | refused |

The first column is not a description of intent; it is how the dispatcher tells them apart.
Everything in `core/ssh-command.ts` base64-encodes a script and pipes it into a remote `sh`, so
for shipkit the command is always the same word and the script is on stdin. Kamal drives the
server through SSHKit and sends its command in the usual way.

The allow-list is one entry per function in the module that builds a remote script, named after
it: `plan/server-probe`, `backup/pg-dump`, `migrate/run-bundle`, `lock/acquire`, and so on.
A script that is not one of them is refused and logged in full.

### What the restriction does not do

It does not make the key unprivileged, and reading it as though it does is the mistake worth
avoiding.

Kamal's commands are generated from `config/deploy.yml`, which lives in the repository the
workflow runs from. Anyone who can change that file can change the command. An allow-list over
a set the caller writes is a list of whatever the caller wanted, so Kamal's channel is a
deny-list instead: it refuses `--privileged`, `--cap-add`, `--device`, `--security-opt`, a host
namespace, the docker socket, and any bind mount whose source is not under `~/.kamal`,
`/var/backups/shipkit` or a migration bundle's staging directory.

**A deny-list is not a gate, and this one leaves a door open on purpose.** Say it concretely,
because it is the thing most likely to be misread:

```
ssh -i <deploy key> deploy@HOST 'id'
uid=1000(deploy) gid=1000(deploy) groups=1000(deploy),100(users),988(docker)
```

That runs. Any command that is not docker-shaped goes through Kamal's channel, executes as
`deploy`, and is logged as `allowed` — where `allowed` means "not on the deny-list", not
"checked". The key is still a key to that account. What the restriction takes away is the
shell, the forwards, sftp, arbitrary file transfer, the escalation arguments, and — on
shipkit's own channel, which is where seventeen of the nineteen commands go — everything that
is not one of the seventeen.

`tools/replay-ssh-shapes.py` asserts this gap in the direction it actually behaves, so it
reports a change on the day somebody closes it. Closing it properly means pinning Kamal's own
command set, which can only be done from a log of a real deploy on that server — see
**Testing a change before trusting it**.

It also takes a PTY away from that account, which the pipeline never wanted but a person
might: `kamal app exec --interactive` and `kamal shell` stop working *as the deploy key*.
Run them as root with an admin key, or undo the restriction for as long as you need one.

**What actually bounds "anyone who can run a workflow" is upstream of this server.** A GitHub
environment with required reviewers on the production deploy does; a forced command on the
server does not. This restriction narrows what the key can do *once a deploy is running*. It
does not decide who gets to run one.

## Turning it on

**First check which kit commit the project pins.** The restriction refuses sftp, and OpenSSH 9
made `scp` speak SFTP by default — so a pipeline whose `scp` does not pass `-O` has its backup
upload refused, at the backup stage, on the first deploy after you switch this on. `SCP_LEGACY`
in `core/ssh-command.ts` is what passes it. A server must not be restricted until the `kit:`
line in its `shipkit.yaml` names a commit that has it:

```bash
grep '^kit:' shipkit.yaml                       # in the client repo
git -C <shipkit checkout> log --oneline -1 <that commit> -- .dagger/src/core/ssh-command.ts
grep -n 'SCP_LEGACY' <shipkit checkout>/.dagger/src/core/ssh-command.ts
```

This is the one ordering mistake that turns a green pipeline red, and it does it after the
backup gate has already been reached.

So the order is part of the procedure, not a detail:

1. the kit change merges here;
2. the client repo re-pins `kit:` to a commit that has it, and deploys once on that commit;
3. only then is that client's server restricted — and restricting production is a decision
   taken deliberately, per server, not a step that follows automatically from step 2.

A test server can be restricted at step 1, because the thing you are testing is the
restriction.

After `prepare` and `harden`, with the key proven to work and the kit commit checked:

```bash
ssh root@HOST 'bash -s' -- restrict --user deploy < server/bootstrap.sh
```

It refuses to run if sshd has never accepted a key login for that user — restricting a key
nobody has seen work means the next failure has two possible causes. Before it reloads sshd it
asks the dispatcher directly, on the server, whether it allows a deploy script, refuses one
that is not, and refuses a session with no command at all. If any of the three answers is
wrong it removes its own sshd drop-in and changes nothing.

It writes three things, all root-owned and all outside the deploy user's home:

| | |
|---|---|
| `/usr/local/lib/shipkit/deploy-dispatch` | the forced command |
| `/etc/shipkit/deploy-key.policy` | `shipkit=enforce`, `kamal=enforce` |
| `/etc/ssh/authorized_keys.d/deploy` | the authorised key, with `restrict` |

Outside the home directory is the point. `~/.ssh/authorized_keys` belongs to `deploy`, so a
session that could write one file could lift its own restriction; `Match User deploy` in
`/etc/ssh/sshd_config.d/10-shipkit-deploy-key.conf` points sshd at the root-owned copy instead.
`~/.ssh/authorized_keys` is left exactly as it was, which is what makes the undo one command.

## The changes to `config/deploy.yml` that break this

Kamal's channel allows a bind mount only when its source is under `~/.kamal`,
`/var/backups/shipkit`, or a migration bundle's staging directory. Docker *volumes* are not
paths and are not checked — `easytransfer-uploads:/app/uploads` and `data:/var/lib/postgresql/data`
are volume names, and they pass.

So:

| In `config/deploy.yml` | What happens |
|---|---|
| `volumes: name:/in/container` | fine — a volume name, not a host path |
| `files: local:/in/container` | fine — Kamal stages these under `~/.kamal` and mounts from there |
| `volumes: /srv/thing:/in/container` | **refused** — an absolute host path outside the allowed roots |
| `--privileged`, `cap_add`, `devices` on an accessory | **refused** |

The third row is the one to watch, and it will not announce itself: someone adds a host
directory to an accessory, the deploy is refused at the release stage, and nothing in
`deploy.yml` looks unusual. The log names the exact mount
(`detail=a bind mount of /srv/thing`). Either move it to a named volume, or add its root to
`MOUNT_ROOTS` in the dispatcher and say in the commit why that path is as safe as the others.

Nothing in the policy is keyed to a service name, deliberately: production runs two Kamal
services — `easytransfer-api` and `easytransfer-web` — as the same `deploy` user, and a rule
written for one would refuse the other. `tests/deploy-key.test.ts` asserts that no service name
appears in the dispatcher at all.

## Testing a change before trusting it

Never on production first, and never by reasoning about the regexes.

The shapes the pipeline sends are generated by the module's own functions rather than
transcribed, so the test cannot drift from the code by someone forgetting to update it.
`tools/shapes.jsonl` in the repository is the last generated copy — evidence of what the kit
sent on that commit, not a fixture to hand-edit. Regenerate it and replay:

```bash
node --experimental-strip-types tools/emit-ssh-shapes.ts > tools/shapes.jsonl
python3 tools/replay-ssh-shapes.py            # against the test server, never production
```

`npm test` runs the cheaper half of this without a server: `tests/deploy-key.test.ts` extracts
the dispatcher out of `server/bootstrap.sh` and asks it about every shape the module produces,
so a remote script that grows past the allow-list fails the suite rather than a deploy.

Every shape must get through, and every forbidden thing must be refused. A shape that fails
means the pipeline grew a command the allow-list has not been told about — add it to `SHAPES`
in the dispatcher (inside `server/bootstrap.sh`), not to the server by hand, or the next
rebuild loses it.

If you need to see what a caller actually sends before you can write the shape:

```bash
ssh root@HOST 'printf "shipkit=audit\nkamal=enforce\n" > /etc/shipkit/deploy-key.policy'
```

`audit` logs and allows. **It is not a gate while it is set**, so it is a thing you switch on,
read, and switch off — not a state a server is left in. Then:

```bash
ssh root@HOST 'journalctl -t shipkit-deploy-key --no-pager -n 100 -o cat'
```

Every decision is there: `allowed`, `audited` or `refused`, which channel, the client address,
a digest of the script and the script itself when it was refused. The one script that carries a
secret — the migration bundle's connection string — is matched before anything is logged, and
the log carries its digest rather than its text.

## When it locks the pipeline out

This is the part that matters at three in the morning, so it is one command and it needs
nothing but root:

```bash
ssh root@HOST 'rm -f /etc/ssh/sshd_config.d/10-shipkit-deploy-key.conf && sshd -t && systemctl reload ssh'
```

`deploy` immediately goes back to `~/.ssh/authorized_keys`, unrestricted, with a shell. Nothing
else is touched: the dispatcher, the policy and the root-owned key file all stay where they
are, so putting it back is `restrict` again. `bootstrap.sh unrestrict` does the same thing with
the same effect, for when you would rather not type a path from memory.

Existing sessions keep whatever they had when they started, so a deploy already in flight is
not cut off by either direction of this change. **Never cancel a deploy in flight to do it.**

Three things to know before you reach for the undo:

- **Root is a separate door and it is still open.** `harden` leaves `PermitRootLogin
  prohibit-password`, so an admin key reaches root even when the deploy key is refusing
  everything. The restriction cannot lock you out of the machine; it can only lock the
  pipeline out of deploying.
- **Read the log first.** `journalctl -t shipkit-deploy-key` will usually name the problem in
  one line — a script shape the kit changed, an scp to a path that moved, a mount added to
  `config/deploy.yml`. Undoing without reading means doing this again next week.
- **Undoing is the right call when the deploy is the emergency.** Get the release out, then fix
  the shape and turn it back on in daylight. What is not the right call is leaving it off and
  writing a note about it.

One trap worth knowing before you use the undo in anger. `~/.ssh/authorized_keys` still belongs
to `deploy` — sshd ignores it while the restriction is on, and the undo makes it live again. So
if the reason you are undoing is that you think the key was misused, read that file before you
reload sshd; a key appended to it during the restricted window would start working at exactly
the moment you stopped looking.

## When the server is rebuilt

`restrict` is a phase of `server/bootstrap.sh`, so it comes back with the server. The dispatcher
is embedded in that script rather than shipped beside it, because bootstrap is piped to the
server over stdin (`ssh root@HOST 'bash -s' -- ... < server/bootstrap.sh`) and nothing else
arrives with it.

`bootstrap.sh check` says which state the key is in:

```
  deploy key             restricted to a forced command (shipkit=enforce kamal=enforce)
```

or

```
  deploy key             UNRESTRICTED (a shell, and deploy is in the docker group)
```

A server that says the second thing after a rebuild has had `prepare` and `harden` run and not
`restrict`.
