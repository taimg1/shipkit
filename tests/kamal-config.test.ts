import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { checkSsh, declaredSecrets, hostKeyRefusal, kamalHostKeyProblem, missingSecrets, parseKamalSsh } from "../.dagger/src/core/kamal-config.ts"

test("reads ssh user and port from deploy.yml", () => {
  const yml = `service: app\nssh:\n  user: deploy\n  port: 2222   # dev-server\nproxy:\n  ssl: false\n`
  assert.deepEqual(parseKamalSsh(yml), { user: "deploy", port: 2222 })
})

test("without an ssh block Kamal's defaults apply", () => {
  assert.deepEqual(parseKamalSsh(`service: app\nservers:\n  web:\n    - 1.2.3.4\n`), { user: "root", port: 22 })
})

test("a user key under another block is not the ssh user", () => {
  const yml = `registry:\n  username: me\n  user: nope\nssh:\n  port: 22\n`
  assert.deepEqual(parseKamalSsh(yml), { user: "root", port: 22 })
})

test("quoted values are read", () => {
  assert.deepEqual(parseKamalSsh(`ssh:\n  user: "deploy"\n  port: '22'\n`), { user: "deploy", port: 22 })
})

test("a user that differs between the two files fails", () => {
  const line = checkSsh("prod", { sshUser: "deploy", sshPort: 22 }, { user: "root", port: 22 })
  assert.match(line, /^MISMATCH/)
})

test("a port that differs fails", () => {
  assert.match(checkSsh("prod", { sshUser: "deploy", sshPort: 22 }, { user: "deploy", port: 2222 }), /^MISMATCH/)
})

test("root is a warning, not a pass", () => {
  assert.match(checkSsh("prod", { sshUser: "root", sshPort: 22 }, { user: "root", port: 22 }), /^WARN/)
})

test("a deploy user that matches is ok", () => {
  assert.match(checkSsh("prod", { sshUser: "deploy", sshPort: 22 }, { user: "deploy", port: 22 }), /^ok/)
})

test("without deploy.yml the settings are still checked for root", () => {
  assert.match(checkSsh("prod", { sshUser: "root", sshPort: 22 }, null), /^WARN/)
  assert.match(checkSsh("prod", { sshUser: "deploy", sshPort: 22 }, null), /^ok/)
})

// #19: only KAMAL_REGISTRY_PASSWORD ever reached Kamal, so every other declared secret resolved
// to an empty string and the deploy carried on with it.
test("collects the secrets the app declares", () => {
  const yml = [
    "service: app",
    "env:",
    "  clear:",
    "    ASPNETCORE_ENVIRONMENT: Production",
    "  secret:",
    "    - ConnectionStrings__Default",
    "    - Telegram__BotToken",
    "volumes:",
    "  - data:/data",
  ].join("\n")
  assert.deepEqual(declaredSecrets(yml), ["ConnectionStrings__Default", "Telegram__BotToken"])
})

// An accessory's database password is exactly the one that was empty on the first real deploy.
test("collects an accessory's secrets too", () => {
  const yml = [
    "env:",
    "  secret:",
    "    - ConnectionStrings__Default",
    "accessories:",
    "  db:",
    "    image: postgres:17-alpine",
    "    env:",
    "      clear:",
    "        POSTGRES_USER: app",
    "      secret:",
    "        - POSTGRES_PASSWORD",
  ].join("\n")
  assert.deepEqual(declaredSecrets(yml).sort(), ["ConnectionStrings__Default", "POSTGRES_PASSWORD"])
})

test("a name declared in both places is asked for once", () => {
  const yml = "env:\n  secret:\n    - SHARED\naccessories:\n  db:\n    env:\n      secret:\n        - SHARED\n"
  assert.deepEqual(declaredSecrets(yml), ["SHARED"])
})

test("comments and quotes do not become secret names", () => {
  const yml = 'env:\n  secret:   # only what exists\n    - "QUOTED"\n    - PLAIN   # trailing\n'
  assert.deepEqual(declaredSecrets(yml), ["QUOTED", "PLAIN"])
})

test("a list that ends returns to ignoring what follows", () => {
  const yml = "env:\n  secret:\n    - ONE\nvolumes:\n  - data:/data\nservers:\n  web:\n    - 1.2.3.4\n"
  assert.deepEqual(declaredSecrets(yml), ["ONE"])
})

test("nothing declared is not an error", () => {
  assert.deepEqual(declaredSecrets("service: app\nservers:\n  web:\n    - 1.2.3.4\n"), [])
})

test("a declared secret the file does not provide is named", () => {
  const file = "ConnectionStrings__Default=Host=db\n"
  assert.deepEqual(missingSecrets(["ConnectionStrings__Default", "POSTGRES_PASSWORD"], file), [
    "POSTGRES_PASSWORD",
  ])
})

// The exact shape that deployed an empty password to production: the name was there, the value
// was still the reference nobody had resolved.
test("an unresolved reference counts as missing, not as provided", () => {
  assert.deepEqual(missingSecrets(["POSTGRES_PASSWORD"], "POSTGRES_PASSWORD=$POSTGRES_PASSWORD\n"), [
    "POSTGRES_PASSWORD",
  ])
})

test("an empty value counts as missing", () => {
  assert.deepEqual(missingSecrets(["A"], "A=\n"), ["A"])
})

test("everything provided is nothing missing", () => {
  assert.deepEqual(missingSecrets(["A", "B"], "A=1\nB=2\n"), [])
})

test("a deploy.yml that leaves ssh.config alone lets Kamal verify host keys", () => {
  assert.equal(kamalHostKeyProblem(`ssh:\n  user: deploy\n  port: 22\n`), null)
  assert.equal(kamalHostKeyProblem(`service: app\n`), null)
  assert.equal(kamalHostKeyProblem(`ssh:\n  config: true   # default\n`), null)
})

test("ssh.config false or a path switches host key verification off, so it is refused", () => {
  assert.match(kamalHostKeyProblem(`ssh:\n  user: deploy\n  config: false\n`) ?? "", /ssh\.config to false/)
  assert.match(kamalHostKeyProblem(`ssh:\n  config: [ "~/.ssh/myconfig" ]\n`) ?? "", /ssh\.config/)
  assert.match(kamalHostKeyProblem(`ssh:\n  config:\n    - ~/.ssh/myconfig\n`) ?? "", /a list/)
})

test("a config key under another block is not ssh.config", () => {
  assert.equal(kamalHostKeyProblem(`builder:\n  config: false\nssh:\n  user: deploy\n`), null)
})

test("an inline ssh block cannot be checked, so it is refused", () => {
  assert.match(kamalHostKeyProblem(`ssh: { user: deploy, config: false }\n`) ?? "", /inline/)
})

test("the fixture's deploy.yml passes", () => {
  const yml = readFileSync(new URL("../fixtures/dotnet-api/config/deploy.yml", import.meta.url), "utf8")
  assert.equal(kamalHostKeyProblem(yml), null)
})

test("net-ssh's host key refusals are recognised in Kamal's output", () => {
  const out = `  ERROR (SSHKit::Runner::ExecuteError): Exception while executing on host h: fingerprint SHA256:abc is unknown for "[h]:2222"\n`
  assert.equal(hostKeyRefusal(out), 'fingerprint SHA256:abc is unknown for "[h]:2222"')
  assert.match(hostKeyRefusal(`fingerprint SHA256:x/y+z does not match for "1.2.3.4"`) ?? "", /does not match/)
  assert.equal(hostKeyRefusal("App Host: h\nsha-abc1234\n"), null)
})
