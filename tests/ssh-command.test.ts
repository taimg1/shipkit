import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { hostKeyOptions, remoteScript, shq, sshArgs, sshPrefix } from "../.dagger/src/core/ssh-command.ts"

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
  assert.match(args, /StrictHostKeyChecking=yes/)
  assert.match(args, /UserKnownHostsFile=\/root\/\.ssh\/known_hosts/)
  assert.match(args, /BatchMode=yes/)
})

test("no ssh or scp anywhere trusts a host key on first sight", () => {
  // accept-new against a known_hosts file that is empty in every fresh container is no check
  // at all; `no` is worse. Only the pinned key (hostKey) may be accepted.
  assert.doesNotMatch(hostKeyOptions.join(" "), /accept-new|StrictHostKeyChecking=no/)
  for (const file of ["ssh-command.ts", "ssh.ts", "migrate.ts", "release.ts", "backup.ts", "plan.ts", "history.ts"]) {
    const src = readFileSync(new URL(`../.dagger/src/core/${file}`, import.meta.url), "utf8")
    assert.doesNotMatch(src, /StrictHostKeyChecking=(accept-new|no)\b/, file)
  }
})

test("shq: any value comes back from a shell exactly as it went in", () => {
  const values = ["", "plain", "it's", `a"b$c\`d\\e'f g`, "$(id)", "`id`", "a;b|c&d", "-rf", "\n\t", "'''"]
  for (const v of values) {
    const r = spawnSync("sh", ["-c", `printf '%s' ${shq(v)}`], { encoding: "utf8" })
    assert.equal(r.stdout, v, JSON.stringify(v))
  }
})

test("shq: safe values stay readable, anything else is single-quoted", () => {
  assert.equal(shq("deploy@server.example"), "deploy@server.example")
  assert.equal(shq("StrictHostKeyChecking=accept-new"), "StrictHostKeyChecking=accept-new")
  assert.equal(shq("a b"), "'a b'")
  assert.equal(shq("it's"), `'it'\\''s'`)
})

test("the ssh prefix quotes the user and host, so neither can add a command", () => {
  const hostile = { ...env, sshUser: "deploy;touch pwned", host: "h$(id)" }
  assert.match(sshPrefix(hostile), / 'deploy;touch pwned@h\$\(id\)'$/)
  assert.match(remoteScript(hostile, "true"), /'deploy;touch pwned@h\$\(id\)' sh$/)
})
