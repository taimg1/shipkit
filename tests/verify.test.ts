import { test } from "node:test"
import assert from "node:assert/strict"
import { readVersion, versionMatchesTag } from "../.dagger/src/core/health.ts"

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
