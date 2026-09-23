import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// The hub is Python because a watched Ubuntu server has python3 and nothing else is
// installed on it (hub/README is the rule). Its decisions are still the kit's decisions, so
// they are tested from here, by calling the module the bot and the ingest command call.
const HUB = fileURLToPath(new URL("../hub/", import.meta.url))

const DRIVER = `
import json, sys
sys.path.insert(0, sys.argv[1])
import statuslib
req = json.load(sys.stdin)
try:
    print(json.dumps({"ok": True, "value": getattr(statuslib, req["fn"])(*req["args"])}))
except statuslib.Rejected as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
`

const call = (fn: string, ...args: unknown[]) => {
  const out = spawnSync("python3", ["-c", DRIVER, HUB], { input: JSON.stringify({ fn, args }), encoding: "utf8" })
  assert.equal(out.status, 0, `python3 failed: ${out.stderr}`)
  return JSON.parse(out.stdout) as { ok: boolean; value?: any; error?: string }
}

const ok = (fn: string, ...args: unknown[]) => {
  const r = call(fn, ...args)
  assert.ok(r.ok, `expected success, got: ${r.error}`)
  return r.value
}

const snap = (receivedAt: number, extra: Record<string, unknown> = {}) => ({
  server: "s",
  received_at: receivedAt,
  app: { version: "sha-abc1234" },
  ...extra,
})

// --- what the hub accepts, and whose snapshot it becomes -------------------------------

test("the client name comes from the key, so a payload cannot claim another server", () => {
  const value = ok("normalise", JSON.stringify({ server: "production", hostname: "impostor" }), "testserver", 1000)
  assert.equal(value.server, "testserver")
  assert.equal(value.hostname, "impostor")
})

test("received_at is the hub's clock, not the client's collected_at", () => {
  const value = ok("normalise", JSON.stringify({ collected_at: 1 }), "s", 1000)
  assert.equal(value.received_at, 1000)
  assert.equal(value.collected_at, 1)
})

test("a payload that is not JSON is refused", () => {
  assert.match(call("normalise", "not json", "s", 0).error!, /not JSON/)
})

test("a payload that is not an object is refused", () => {
  assert.match(call("normalise", "[1,2,3]", "s", 0).error!, /not a JSON object/)
})

test("a payload over the cap is refused rather than read into memory", () => {
  const big = JSON.stringify({ pad: "x".repeat(70 * 1024) })
  assert.match(call("normalise", big, "s", 0).error!, /larger than/)
})

test("a client name that could escape the snapshot directory is refused", () => {
  for (const bad of ["../other", "a/b", "", "Upper", "-leading"]) {
    assert.match(call("normalise", "{}", bad, 0).error!, /not a valid name/, `accepted ${bad}`)
  }
})

// --- the silence rule ------------------------------------------------------------------

test("silence begins after the threshold, not at it", () => {
  assert.equal(ok("is_silent", snap(0), 180), false)
  assert.equal(ok("is_silent", snap(0), 181), true)
})

test("going silent alerts once, and staying silent does not alert again", () => {
  const snaps = { prod: snap(0) }
  const [state1, first] = ok("silence_events", {}, snaps, 400)
  assert.equal(first.length, 1)
  assert.match(first[0], /^SILENT: prod has not pushed for 6m \(was sha-abc1234\)\.$/)

  const [, second] = ok("silence_events", state1, snaps, 460)
  assert.deepEqual(second, [])
})

test("coming back alerts once", () => {
  const [state, none] = ok("silence_events", { prod: true }, { prod: snap(1000) }, 1010)
  assert.deepEqual(none, ["BACK: prod is pushing again."])
  assert.deepEqual(state, { prod: false })
})

test("a healthy server that was never silent produces nothing", () => {
  const [, messages] = ok("silence_events", {}, { prod: snap(1000) }, 1010)
  assert.deepEqual(messages, [])
})

test("a disconnected server leaves the state instead of staying silent forever", () => {
  const [state] = ok("silence_events", { gone: true, prod: false }, { prod: snap(1000) }, 1010)
  assert.deepEqual(state, { prod: false })
})

// --- commands --------------------------------------------------------------------------

test("a command is split into verb and argument", () => {
  assert.deepEqual(ok("parse_command", "/load prod"), ["load", "prod"])
  assert.deepEqual(ok("parse_command", "/status"), ["status", null])
  // Telegram appends @botname whenever several bots share a chat.
  assert.deepEqual(ok("parse_command", "/deploys@shipkit_hub_bot prod"), ["deploys", "prod"])
  assert.deepEqual(ok("parse_command", "  /backups   prod  "), ["backups", "prod"])
})

test("anything that is not a command is not answered", () => {
  for (const text of ["hello", "", "/", null, 7]) {
    assert.equal(ok("parse_command", text), null, `treated ${JSON.stringify(text)} as a command`)
  }
})

test("a server nobody has heard of is named, not guessed at", () => {
  const reply = ok("answer", "load", "staging", { prod: snap(0) }, 0)
  assert.match(reply, /No server called staging\. Known: prod/)
})

test("a per-server command with no server lists the ones there are", () => {
  assert.match(ok("answer", "load", null, { prod: snap(0), test: snap(0) }, 0), /Which server\? prod, test/)
})

test("an unknown command answers with the four that exist", () => {
  assert.match(ok("answer", "help", null, {}, 0), /\/status, \/load <server>, \/deploys <server>, \/backups <server>/)
})

// --- what the answers say ---------------------------------------------------------------

test("status marks the silent server and ages both", () => {
  const reply = ok("answer", "status", null, { prod: snap(0), test: snap(3000) }, 3010)
  assert.match(reply, /prod\s+SILENT\s+50m ago\s+sha-abc1234/)
  assert.match(reply, /test\s+alive\s+10s ago\s+sha-abc1234/)
})

test("status with nothing connected says so rather than printing an empty table", () => {
  assert.match(ok("answer", "status", null, {}, 0), /No server has ever pushed/)
})

test("a server with no version reported is not shown as having one", () => {
  assert.match(ok("answer", "status", null, { prod: snap(0, { app: null }) }, 0), /version unknown/)
})

test("deploys tells an absent audit log apart from an empty one", () => {
  assert.match(ok("answer", "deploys", "p", { p: snap(0, { deploys: null }) }, 0), /No Kamal audit log/)
  assert.match(ok("answer", "deploys", "p", { p: snap(0, { deploys: [] }) }, 0), /audit log is empty/)
  assert.match(ok("answer", "deploys", "p", { p: snap(0, { deploys: ["a", "b"] }) }, 0), /last 2 entries/)
})

test("backups tells an absent dump directory apart from an empty one", () => {
  assert.match(ok("answer", "backups", "p", { p: snap(0, { backups: null }) }, 0), /No dump directory/)
  assert.match(ok("answer", "backups", "p", { p: snap(0, { backups: [] }) }, 0), /holds no service/)
  const withDump = snap(0, {
    backups: [{ service: "api", newest: "api-2026.sql.gz", size_bytes: 4194304, age_seconds: 7200 }],
  })
  assert.match(ok("answer", "backups", "p", { p: withDump }, 0), /api: api-2026\.sql\.gz\s+4\.0M\s+2h 0m old/)
})

test("a dump directory with no dump in it is named, not skipped", () => {
  const empty = snap(0, { backups: [{ service: "api", dir: "/var/backups/shipkit/api", newest: null }] })
  assert.match(ok("answer", "backups", "p", { p: empty }, 0), /api: no dump in \/var\/backups\/shipkit\/api/)
})

test("load reports a failed health probe as a failure, not as a missing section", () => {
  const s = snap(0, { app: { url: "http://127.0.0.1:3000/health", ok: false, error: "HTTP 502" } })
  assert.match(ok("answer", "load", "p", { p: s }, 0), /health http:\/\/127\.0\.0\.1:3000\/health -> FAILED: HTTP 502/)
})

test("load says containers are none rather than printing an empty heading", () => {
  assert.match(ok("answer", "load", "p", { p: snap(0, { containers: [] }) }, 0), /containers: none running/)
})

test("ages read as durations", () => {
  assert.equal(ok("human_age", 59), "59s")
  assert.equal(ok("human_age", 60), "1m")
  assert.equal(ok("human_age", 3600), "1h 0m")
  assert.equal(ok("human_age", 90061), "1d 1h")
})

// --- the ingest command, which is what sshd actually runs --------------------------------

const ingest = (payload: string, client: string, dir: string) =>
  spawnSync("python3", [join(HUB, "ingest.py"), client], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, SHIPKIT_HUB_SNAPSHOTS: dir },
  })

test("ingest stores the snapshot under the name in its own argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-hub-"))
  try {
    // What a compromised client would send: its own key, another server's name in the body.
    const out = ingest(JSON.stringify({ server: "production", secret: 1 }), "testserver", dir)
    assert.equal(out.status, 0, out.stderr)
    assert.equal(JSON.parse(readFileSync(join(dir, "testserver.json"), "utf8")).server, "testserver")
    assert.throws(() => readFileSync(join(dir, "production.json")), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ingest refuses a payload and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-hub-"))
  try {
    const out = ingest("rm -rf /", "testserver", dir)
    assert.equal(out.status, 1)
    assert.match(out.stderr, /rejected: snapshot is not JSON/)
    assert.throws(() => readFileSync(join(dir, "testserver.json")), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ingest with no client argument refuses rather than writing a stray file", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-hub-"))
  try {
    const out = ingest("{}", "", dir)
    assert.equal(out.status, 1)
    assert.match(out.stderr, /not a valid name/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
