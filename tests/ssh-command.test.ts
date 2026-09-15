import { test } from "node:test"
import assert from "node:assert/strict"
import { remoteScript, sshArgs } from "../.dagger/src/core/ssh-command.ts"

const env = {
  url: "http://example.test",
  host: "server.example",
  sshPort: 2222,
  sshUser: "deploy",
  network: "kamal",
  database: "app",
  dbUser: "postgres",
}

const decode = (command: string) => {
  const b64 = /^echo (\S+) \| base64 -d \|/.exec(command)?.[1]
  assert.ok(b64, `no encoded payload in: ${command}`)
  return Buffer.from(b64, "base64").toString("utf8")
}

test("the script survives encoding unchanged", () => {
  const script = `docker exec db psql -tAc "select 1"`
  assert.equal(decode(remoteScript(env, script)), script)
})

test("a single quote cannot break out of the command", () => {
  // The exact shape of the bug: quoting this into an ssh argument closed the outer quote,
  // the remote command became something else, and production looked empty.
  const script = `psql -tAc "select count(*) from information_schema.tables where table_schema='public'"`
  assert.equal(decode(remoteScript(env, script)), script)
})

test("double quotes, backslashes and dollars survive", () => {
  const script = `echo "a \\" b" && printf '%s' "$HOME" \; true`
  assert.equal(decode(remoteScript(env, script)), script)
})

test("a multi-line script survives", () => {
  const script = "set -e\nchmod +x /tmp/bundle\n/tmp/bundle --connection \"Host=db;Password=p'w\""
  assert.equal(decode(remoteScript(env, script)), script)
})

test("the encoded payload contains no shell metacharacters", () => {
  const command = remoteScript(env, `rm -rf / ; echo '"$(whoami)"'`)
  const payload = /^echo (\S+) \|/.exec(command)?.[1] ?? ""
  assert.match(payload, /^[A-Za-z0-9+/=]+$/, "base64 only, so nothing can be interpreted")
})

test("ssh args carry the port, the user and host-key checking", () => {
  const args = sshArgs(env).join(" ")
  assert.match(args, /-p 2222/)
  assert.match(args, /deploy@server\.example/)
  assert.match(args, /StrictHostKeyChecking=accept-new/)
  assert.match(args, /BatchMode=yes/)
})
