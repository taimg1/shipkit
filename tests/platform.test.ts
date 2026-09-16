import { test } from "node:test"
import assert from "node:assert/strict"
import { dockerPlatform, SUPPORTED_RIDS } from "../.dagger/src/core/platform.ts"

test("the default runtime identifier builds for x86 servers", () => {
  assert.equal(dockerPlatform("linux-x64"), "linux/amd64")
})

test("musl differs in libc, not in architecture", () => {
  assert.equal(dockerPlatform("linux-musl-x64"), "linux/amd64")
  assert.equal(dockerPlatform("linux-musl-arm64"), "linux/arm64")
})

test("arm64 is supported, for servers that actually are arm — dev-server among them", () => {
  assert.equal(dockerPlatform("linux-arm64"), "linux/arm64")
})

// Guessing would produce an image that builds, publishes and then cannot run — the exact
// failure this module exists to prevent. Null forces the caller to refuse.
test("an unknown runtime identifier is null, never a default", () => {
  assert.equal(dockerPlatform("win-x64"), null)
  assert.equal(dockerPlatform(""), null)
})

test("the supported list is what the caller puts in its error message", () => {
  assert.ok(SUPPORTED_RIDS.includes("linux-x64"))
  assert.ok(SUPPORTED_RIDS.every((rid) => dockerPlatform(rid) !== null))
})
