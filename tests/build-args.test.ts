import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parseBuildArgs } from "../.dagger/src/build-args.ts"

// Next inlines NEXT_PUBLIC_* at build time, so a site needs its public configuration during
// `build`. It lives in shipkit.yaml because the image tag is the commit: a value that varied
// per run would make one commit mean two different images.

const ok = (raw: unknown) => {
  const r = parseBuildArgs(raw)
  assert.equal(r.ok, true, r.ok ? "" : r.message)
  return r.ok ? r.args : {}
}

const refused = (raw: unknown) => {
  const r = parseBuildArgs(raw)
  assert.equal(r.ok, false, "accepted something it should refuse")
  return r.ok ? "" : r.message
}

test("values come back as strings, numbers and booleans included", () => {
  assert.deepEqual(
    ok({ NEXT_PUBLIC_SITE_URL: "https://example.com", NEXT_PUBLIC_LIMIT: 3, NEXT_PUBLIC_FLAG: true }),
    { NEXT_PUBLIC_SITE_URL: "https://example.com", NEXT_PUBLIC_LIMIT: "3", NEXT_PUBLIC_FLAG: "true" },
  )
})

test("an empty string stays: a flag deliberately off is not a missing flag", () => {
  assert.deepEqual(ok({ NEXT_PUBLIC_FLAG: "" }), { NEXT_PUBLIC_FLAG: "" })
})

test("absent means none, not undefined", () => {
  assert.deepEqual(ok(undefined), {})
  assert.deepEqual(ok(null), {})
})

test("GIT_SHA cannot be set by the project", () => {
  assert.match(refused({ GIT_SHA: "whatever" }), /must not set GIT_SHA/)
})

test("a name that is not a build argument name is refused", () => {
  assert.match(refused({ "a-b": "x" }), /usable build argument name/)
  assert.match(refused({ "1ST": "x" }), /usable build argument name/)
  assert.match(refused({ "A B": "x" }), /usable build argument name/)
})

test("a value with no text is refused rather than guessed", () => {
  assert.match(refused({ A: null }), /must be a value/)
  assert.match(refused({ A: { b: "c" } }), /must be a value/)
})

test("buildArgs itself must be a mapping", () => {
  assert.match(refused(["A=1"]), /mapping of NAME/)
  assert.match(refused("A=1"), /mapping of NAME/)
})

test("the kit passes GIT_SHA first, so a project value could never shadow it", () => {
  const src = readFileSync(new URL("../.dagger/src/index.ts", import.meta.url), "utf8")
  const args = src.slice(src.indexOf("buildArgs: ["))
  assert.ok(args.indexOf('name: "GIT_SHA"') < args.indexOf("cfg.buildArgs"), "GIT_SHA is no longer first")
})
