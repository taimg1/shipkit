import { test } from "node:test"
import assert from "node:assert/strict"
import { readVersion } from "../.dagger/src/core/health.ts"

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
