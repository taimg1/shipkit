import { test } from "node:test"
import assert from "node:assert/strict"
import { parseServerProbe, provisioning, serverProbeScript } from "../.dagger/src/core/server-probe.ts"

const state = (over = {}) => ({ docker: "ok" as const, proxy: "running" as const, db: "running" as const, appContainers: 2, ...over })

test("no answer from the server is not an empty server", () => {
  assert.equal(parseServerProbe("").ok, false)
})

test("a fresh server: docker works, nothing else exists", () => {
  const r = parseServerProbe("docker:ok\nproxy:missing\ndb:missing\napp:0\n")
  assert.deepEqual(r, { ok: true, state: { docker: "ok", proxy: "missing", db: "missing", appContainers: 0 } })
})

test("an incomplete answer is refused", () => {
  assert.equal(parseServerProbe("docker:ok\nproxy:running\n").ok, false)
})

test("a first deploy boots the database and says so", () => {
  const p = provisioning(state({ proxy: "missing", db: "missing", appContainers: 0 }), true)
  assert.equal(p.ok, true)
  assert.match((p as { steps: string[] }).steps.join("; "), /boot the database accessory/)
})

test("a server already running everything needs no steps", () => {
  assert.deepEqual(provisioning(state(), true), { ok: true, steps: [] })
})

test("no docker for the deploy user stops the deploy", () => {
  const p = provisioning({ docker: "unavailable", proxy: "missing", db: "missing", appContainers: 0 }, true)
  assert.equal(p.ok, false)
})

test("a stopped production database is not started on the side of a deploy", () => {
  assert.equal(provisioning(state({ db: "stopped" }), true).ok, false)
})

test("a database that vanished from a server the app has run on is not replaced by an empty one", () => {
  const p = provisioning(state({ db: "missing", appContainers: 3 }), true)
  assert.equal(p.ok, false)
  assert.match((p as { next: string }).next, /restore/)
})

test("a project without a database does not care about one", () => {
  assert.deepEqual(provisioning(state({ db: "missing", appContainers: 0 }), false), { ok: true, steps: [] })
})

test("names from configuration are shell-quoted", () => {
  assert.match(serverProbeScript("app'x", "db'x"), /'db'\\''x'/)
})
