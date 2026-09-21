import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  lockAcquireScript,
  lockDir,
  lockReleaseScript,
  parseLockAcquire,
  unlockCommand,
} from "../.dagger/src/core/deploy-lock.ts"

// B13/C8: the scripts are run for real, against a scratch $HOME standing in for the server's.

const holder = (id: string) => ({ id, sha: "a1b2c3d4e5f6", env: "prod", actor: "alice@laptop" })

function run(script: string, home: string) {
  return spawnSync("sh", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } })
}

test("the first deploy acquires, the second is refused and told who holds it", () => {
  const home = mkdtempSync(join(tmpdir(), "shipkit-lock-"))
  const first = parseLockAcquire(run(lockAcquireScript("api", holder("run-1")), home).stdout)
  assert.deepEqual(first, { ok: true })

  const second = parseLockAcquire(run(lockAcquireScript("api", holder("run-2")), home).stdout)
  assert.equal(second.ok, false)
  assert.ok(!second.ok && second.held)
  if (!second.ok && second.held) {
    assert.match(second.holder, /sha=a1b2c3d4e5f6/)
    assert.match(second.holder, /actor=alice@laptop/)
    assert.match(second.holder, /since=\d{4}-\d\d-\d\dT/)
    assert.doesNotMatch(second.holder, /id=/, "the release id is not shown")
  }
})

test("release removes only our own lock", () => {
  const home = mkdtempSync(join(tmpdir(), "shipkit-lock-"))
  run(lockAcquireScript("api", holder("run-1")), home)
  const dir = join(home, ".shipkit", "deploy-lock-api")

  assert.equal(run(lockReleaseScript("api", "run-2"), home).stdout.trim(), "NOT-OURS")
  assert.ok(existsSync(dir), "someone else's lock survives")

  assert.equal(run(lockReleaseScript("api", "run-1"), home).stdout.trim(), "RELEASED")
  assert.ok(!existsSync(dir))
  assert.deepEqual(parseLockAcquire(run(lockAcquireScript("api", holder("run-3")), home).stdout), { ok: true })
})

test("the lock is not Kamal's and does not collide with it", () => {
  // Kamal's lock is ~/.kamal/lock-<service>. Ours must be somewhere else entirely.
  assert.doesNotMatch(lockDir("api"), /\.kamal/)
  const home = mkdtempSync(join(tmpdir(), "shipkit-lock-"))
  spawnSync("mkdir", ["-p", join(home, ".kamal", "lock-api")])
  assert.deepEqual(parseLockAcquire(run(lockAcquireScript("api", holder("run-1")), home).stdout), { ok: true })
})

test("different services on one server do not share a lock", () => {
  const home = mkdtempSync(join(tmpdir(), "shipkit-lock-"))
  assert.deepEqual(parseLockAcquire(run(lockAcquireScript("api", holder("a")), home).stdout), { ok: true })
  assert.deepEqual(parseLockAcquire(run(lockAcquireScript("web", holder("b")), home).stdout), { ok: true })
})

test("holder values cannot inject shell", () => {
  const home = mkdtempSync(join(tmpdir(), "shipkit-lock-"))
  const evil = { id: "x", sha: "'; touch pwned; '", env: "prod$(touch pwned2)", actor: "a`touch pwned3`" }
  const r = run(`cd "${home}" && ${lockAcquireScript("api", evil)}`, home)
  assert.equal(parseLockAcquire(r.stdout).ok, true)
  for (const f of ["pwned", "pwned2", "pwned3"]) assert.ok(!existsSync(join(home, f)), f)
  assert.match(readFileSync(join(home, ".shipkit", "deploy-lock-api", "holder"), "utf8"), /env=prod__touch_pwned2_/)
})

test("an unreadable answer is not an acquired lock", () => {
  assert.equal(parseLockAcquire("").ok, false)
  assert.equal(parseLockAcquire("Permission denied").ok, false)
  assert.equal(parseLockAcquire("ACQUIRED\nsomething else").ok, false)
  const held = parseLockAcquire("HELD\n")
  assert.ok(!held.ok && held.held)
})

test("an odd service name cannot escape the lock directory", () => {
  assert.equal(lockDir("../../etc"), "$HOME/.shipkit/deploy-lock-app")
  assert.equal(unlockCommand("api"), "rm -rf ~/.shipkit/deploy-lock-api")
})
