import { test } from "node:test"
import assert from "node:assert/strict"
import { parseServerProbe, provisioning, serverProbeScript } from "../.dagger/src/core/server-probe.ts"

const AMD64 = "linux/amd64"
const state = (over = {}) => ({ docker: "ok" as const, proxy: "running" as const, db: "running" as const, appContainers: 2, arch: AMD64 as string | null, archRaw: "x86_64", ...over })

test("no answer from the server is not an empty server", () => {
  assert.equal(parseServerProbe("").ok, false)
})

test("a fresh server: docker works, nothing else exists", () => {
  const r = parseServerProbe("docker:ok\nproxy:missing\ndb:missing\napp:0\n")
  assert.deepEqual(r, { ok: true, state: { docker: "ok", proxy: "missing", db: "missing", appContainers: 0, arch: null, archRaw: "" } })
})

test("an incomplete answer is refused", () => {
  assert.equal(parseServerProbe("docker:ok\nproxy:running\n").ok, false)
})

test("a first deploy boots the database and says so", () => {
  const p = provisioning(state({ proxy: "missing", db: "missing", appContainers: 0 }), true, AMD64)
  assert.equal(p.ok, true)
  assert.match((p as { steps: string[] }).steps.join("; "), /boot the database accessory/)
})

test("a server already running everything needs no steps", () => {
  assert.deepEqual(provisioning(state(), true, AMD64), { ok: true, steps: [] })
})

test("no docker for the deploy user stops the deploy", () => {
  const p = provisioning({ docker: "unavailable", proxy: "missing", db: "missing", appContainers: 0, arch: null, archRaw: "" }, true, AMD64)
  assert.equal(p.ok, false)
})

test("a stopped production database is not started on the side of a deploy", () => {
  assert.equal(provisioning(state({ db: "stopped" }), true, AMD64).ok, false)
})

test("a database that vanished from a server the app has run on is not replaced by an empty one", () => {
  const p = provisioning(state({ db: "missing", appContainers: 3 }), true, AMD64)
  assert.equal(p.ok, false)
  assert.match((p as { next: string }).next, /restore/)
})

test("a project without a database does not care about one", () => {
  assert.deepEqual(provisioning(state({ db: "missing", appContainers: 0 }), false, AMD64), { ok: true, steps: [] })
})

test("names from configuration are shell-quoted", () => {
  assert.match(serverProbeScript("app'x", "db'x"), /'db'\\''x'/)
})

// #18: the image takes the building machine's architecture unless told otherwise, and the
// mismatch is not caught until release — after backup and migrate have already run.
test("reads the architecture the server reports", () => {
  const out = "docker:ok\nproxy:running\ndb:running\napp:2\narch:x86_64\n"
  const r = parseServerProbe(out)
  assert.equal(r.ok && r.state.arch, "linux/amd64")
})

test("an architecture the kit does not know is null, not an assumed match", () => {
  const r = parseServerProbe("docker:ok\nproxy:running\ndb:running\napp:2\narch:s390x\n")
  assert.equal(r.ok && r.state.arch, null)
  assert.equal(r.ok && r.state.archRaw, "s390x")
})

test("an arm image against an x86 server is refused before anything runs", () => {
  const p = provisioning(state(), true, "linux/arm64")
  assert.equal(p.ok, false)
  assert.match(!p.ok ? p.reason : "", /linux\/amd64/)
  assert.match(!p.ok ? p.next : "", /only then fail to start/)
})

test("a server that would not say its architecture is refused, not assumed to agree", () => {
  const p = provisioning(state({ arch: null, archRaw: "" }), true, AMD64)
  assert.equal(p.ok, false)
  assert.match(!p.ok ? p.reason : "", /did not say what architecture/)
})

test("matching architectures pass without adding a step", () => {
  assert.deepEqual(provisioning(state(), true, AMD64), { ok: true, steps: [] })
})
