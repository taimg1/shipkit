import { test } from "node:test"
import assert from "node:assert/strict"
import {
  containerVersionsScript,
  parseContainerVersions,
  parseRetainContainers,
  parseServerProbe,
  provisioning,
  serverProbeScript,
} from "../.dagger/src/core/server-probe.ts"

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

// #11, C12: `kamal rollback` boots a CONTAINER named after the version, and exits 0 when there
// is none. The window is what containers exist, not what images do.
test("asks docker for the service's containers, running or not", () => {
  const s = containerVersionsScript("client-api")
  assert.match(s, /docker ps -a/)
  assert.match(s, /label=service=client-api/)
})

test("the service name is quoted, not interpolated into a shell", () => {
  assert.match(containerVersionsScript("x'; rm -rf /"), /'\\''/)
})

test("versions come from container names, newest first, once each", () => {
  const out = [
    "containers:begin",
    "client-api-web-sha-a1b2c3d",
    "client-api-web-sha-9f8e7d6",
    "client-api-worker-sha-9f8e7d6",
    "containers:end",
  ].join("\n")
  assert.deepEqual(parseContainerVersions(out), ["sha-a1b2c3d", "sha-9f8e7d6"])
})

test("a container Kamal parked as replaced is not a rollback target", () => {
  const out = "containers:begin\nclient-api-web-sha-a1b2c3d_replaced_4f2a91\ncontainers:end\n"
  assert.deepEqual(parseContainerVersions(out), [])
})

test("an empty list is empty, and silence is not an empty list", () => {
  assert.deepEqual(parseContainerVersions("containers:begin\ncontainers:end\n"), [])
  assert.equal(parseContainerVersions(""), null)
  assert.equal(parseContainerVersions("containers:begin\nclient-api-web-sha-a1b2c3d\n"), null)
})

test("retain_containers is read from deploy.yml, with Kamal's default of 5", () => {
  assert.equal(parseRetainContainers("service: x\nretain_containers: 3\n"), 3)
  assert.equal(parseRetainContainers("retain_containers: 7   # keep a week of deploys\n"), 7)
  assert.equal(parseRetainContainers("service: x\n"), 5)
  // Indented under another key is not the top-level setting.
  assert.equal(parseRetainContainers("proxy:\n  retain_containers: 1\n"), 5)
})
