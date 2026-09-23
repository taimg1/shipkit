# tools

Two programs that keep the deploy key's restriction honest. Neither is part of the pipeline;
both exist because `server/bootstrap.sh restrict` puts an allow-list between the kit and the
servers, and an allow-list nobody re-checks becomes a red deploy at the worst moment.

Read `docs/runbooks/deploy-key.md` first.

| | |
|---|---|
| `emit-ssh-shapes.ts` | prints every command the module sends over SSH, built by the module's own functions |
| `replay-ssh-shapes.py` | sends each one to a server with the real deploy key, then tries the things the key must not be able to do |
| `shapes.jsonl` | the last generated output of the first — evidence, not a fixture |

```bash
node --experimental-strip-types tools/emit-ssh-shapes.ts > tools/shapes.jsonl
python3 tools/replay-ssh-shapes.py
```

`shapes.jsonl` is regenerated, never edited. It is committed so that a diff shows when the set
of commands the kit sends has changed — which is exactly when the allow-list needs looking at.
`tests/deploy-key.test.ts` regenerates it in memory on every `npm test` and checks each shape
against the dispatcher, so the two cannot drift silently.

`replay-ssh-shapes.py` defaults to the test server and is overridden with `SHIPKIT_REPLAY_HOST`
and `SHIPKIT_REPLAY_KEY`. **Never run it against production**: it uploads files, takes no deploy
lock, and half of it is deliberately trying to do forbidden things.
