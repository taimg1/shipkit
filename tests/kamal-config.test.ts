import { test } from "node:test"
import assert from "node:assert/strict"
import { checkSsh, parseKamalSsh } from "../.dagger/src/core/kamal-config.ts"

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
