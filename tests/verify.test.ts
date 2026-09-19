import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_VERIFY_TIMEOUT,
  judge,
  parseProbe,
  probeScript,
  readVersion,
  verifySettings,
  versionMatchesTag,
} from "../.dagger/src/core/health.ts"

test("reads the version the fixture actually returns", () => {
  const body = '{"status":"ok","version":"f09ab9de62c407fb507b047dc3cc8557b41407b4"}'
  assert.equal(readVersion(body), "f09ab9de62c407fb507b047dc3cc8557b41407b4")
})

test("accepts a capitalised property", () => {
  assert.equal(readVersion('{"Status":"ok","Version":"abc123"}'), "abc123")
})

test("a healthy response with no version is not a pass", () => {
  // The whole gate rests on telling two releases apart. Without a version it cannot.
  assert.equal(readVersion('{"status":"ok"}'), null)
})

test("an empty version is not a version", () => {
  assert.equal(readVersion('{"status":"ok","version":""}'), null)
})

test("a non-JSON body is not a version", () => {
  assert.equal(readVersion("OK"), null)
  assert.equal(readVersion("<html>502 Bad Gateway</html>"), null)
})

test("a numeric version is refused rather than coerced", () => {
  // Comparing a coerced number against a SHA would never match, but it would match against
  // another coerced number — silently making the gate compare the wrong things.
  assert.equal(readVersion('{"version":123}'), null)
})

// #11: a rollback names a tag, and /health answers with the full commit SHA.
test("a tag matches the full sha it is a prefix of", () => {
  assert.equal(versionMatchesTag("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "sha-a1b2c3d"), true)
})

test("a different sha does not match", () => {
  assert.equal(versionMatchesTag("ffffffffffffffffffffffffffffffffffffffff", "sha-a1b2c3d"), false)
})

// The failure a rollback exists for: nothing is answering.
test("no answer is not a match", () => {
  assert.equal(versionMatchesTag(null, "sha-a1b2c3d"), false)
})

// A tag the kit did not mint cannot be checked by prefix; waving it through would report a
// rollback as verified without having verified anything.
test("a tag the kit did not mint is refused rather than assumed", () => {
  assert.equal(versionMatchesTag("a1b2c3d4e5f6", "latest"), false)
  assert.equal(versionMatchesTag("a1b2c3d4e5f6", "v1.2.3"), false)
})

// --- gate 4 as a whole: version AND readiness, retried until the deadline -------------------

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const body = (version: string) => JSON.stringify({ status: "ok", version })
const seen = (health: [number, string], ready: [number, string] | null = [200, body(SHA)]) => ({
  health: { status: health[0], body: health[1] },
  ready: ready ? { status: ready[0], body: ready[1] } : null,
})
const isSha = (v: string) => v === SHA

test("the expected version, ready, is a pass", () => {
  assert.deepEqual(judge(seen([200, body(SHA)]), isSha), { ok: true, version: SHA })
})

// C4: /health touches nothing. A wrong database password answered it with the right version.
test("the right version that cannot reach its database is not a pass", () => {
  const v = judge(seen([200, body(SHA)], [503, '{"status":"unavailable"}']), isSha)
  assert.deepEqual(v, { ok: false, why: "not-ready", version: SHA, readyStatus: 503 })
})

test("readiness has to be exactly 200", () => {
  assert.equal(judge(seen([200, body(SHA)], [204, ""]), isSha).ok, false)
  assert.equal(judge(seen([200, body(SHA)], [0, ""]), isSha).ok, false)
})

test("readiness answered by another version is not readiness of this release", () => {
  const v = judge(seen([200, body(SHA)], [200, body("0000000")]), isSha)
  assert.equal(v.ok, false)
})

test("a readiness body without a version is accepted on its status", () => {
  assert.equal(judge(seen([200, body(SHA)], [200, "ready"]), isSha).ok, true)
})

// B20: a stale version is a reason to look again, not yet a verdict. The caller retries.
test("the previous version answering is a retryable mismatch, not a pass", () => {
  assert.deepEqual(judge(seen([200, body("0000000")]), isSha), { ok: false, why: "version", version: "0000000" })
})

test("nothing answering, or an error status, is unreachable", () => {
  assert.equal((judge(seen([0, ""]), isSha) as { why: string }).why, "unreachable")
  assert.equal((judge(seen([502, "<html>Bad Gateway</html>"]), isSha) as { why: string }).why, "unreachable")
})

test("with no readiness path configured, the version decides", () => {
  assert.equal(judge(seen([200, body(SHA)], null), isSha).ok, true)
})

test("a rollback is judged by tag prefix", () => {
  assert.equal(judge(seen([200, body(SHA)]), (v) => versionMatchesTag(v, "sha-a1b2c3d")).ok, true)
})

test("the probe asks both URLs, quoted", () => {
  const s = probeScript("http://h/health", "http://h/health/ready")
  assert.match(s, /'http:\/\/h\/health'/)
  assert.match(s, /'http:\/\/h\/health\/ready'/)
  assert.match(probeScript("http://h/x'; rm -rf /", null), /'\\''/)
  assert.doesNotMatch(probeScript("http://h/health", null), /ready_status/)
})

test("the probe's answer is read back, bodies included", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64")
  const out = `health_status:200\nhealth_body:${b64(body(SHA))}\nready_status:503\nready_body:${b64("a:b\nc")}\n`
  assert.deepEqual(parseProbe(out, true), {
    health: { status: 200, body: body(SHA) },
    ready: { status: 503, body: "a:b\nc" },
  })
})

test("a probe that said nothing is nothing answering, never a pass", () => {
  const o = parseProbe("", true)
  assert.equal(o.health.status, 0)
  assert.equal(o.ready!.status, 0)
  assert.equal(judge(o, isSha).ok, false)
})

// --- shipkit.yaml: ready and verifyTimeout -----------------------------------------------------

test("with a database, a readiness path is required", () => {
  const s = verifySettings({}, "postgres")
  assert.equal(s.ok, false)
  assert.match((s as { message: string }).message, /"ready" is required/)
})

test("without a database, readiness is optional", () => {
  assert.deepEqual(verifySettings({}, "none"), { ok: true, ready: undefined, verifyTimeout: DEFAULT_VERIFY_TIMEOUT })
})

test("a readiness path is a path", () => {
  assert.equal(verifySettings({ ready: "health/ready" }, "postgres").ok, false)
  assert.equal(verifySettings({ ready: 1 }, "postgres").ok, false)
  assert.deepEqual(verifySettings({ ready: "/health/ready" }, "postgres"), {
    ok: true, ready: "/health/ready", verifyTimeout: 60,
  })
})

test("the timeout is bounded, whole, and positive", () => {
  assert.equal(verifySettings({ ready: "/r", verifyTimeout: 120 }, "postgres").ok, true)
  for (const bad of [0, -5, 1.5, 601, "60"]) {
    assert.equal(verifySettings({ ready: "/r", verifyTimeout: bad }, "postgres").ok, false, String(bad))
  }
})
