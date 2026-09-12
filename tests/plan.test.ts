import { test } from "node:test"
import assert from "node:assert/strict"
import { planToken } from "../.dagger/src/core/plan-token.ts"

const base = {
  env: "prod",
  url: "https://api.client.com",
  imageTag: "sha-a1b2c3d",
  currentImageTag: "sha-9f8e7d6",
  migrations: ["20260911_AddOrdersIndex"],
  sqlDigest: "abc123",
  sqlPreview: "12 lines",
  destructive: false,
  lastVerifiedBackup: "2026-09-10T03:00:00Z",
}

test("the same plan yields the same token", () => {
  assert.equal(planToken(base), planToken({ ...base }))
})

test("a new commit invalidates the token", () => {
  assert.notEqual(planToken(base), planToken({ ...base, imageTag: "sha-0000000" }))
})

test("production moving under us invalidates the token", () => {
  assert.notEqual(planToken(base), planToken({ ...base, currentImageTag: "sha-1111111" }))
})

test("an extra migration invalidates the token", () => {
  assert.notEqual(planToken(base), planToken({ ...base, migrations: [...base.migrations, "20260912_DropOrders"] }))
})

test("changed SQL with an unchanged migration list invalidates the token", () => {
  assert.notEqual(planToken(base), planToken({ ...base, sqlDigest: "def456" }))
})

test("cosmetic fields do not affect the token", () => {
  // The preview and the backup timestamp are display-only; they must not cause a token
  // mismatch between showing a plan and executing it seconds later.
  assert.equal(planToken(base), planToken({ ...base, sqlPreview: "13 lines", lastVerifiedBackup: null }))
})

test("what is actually serving does not affect the token", () => {
  // servingVersion is shown to the reader as a cross-check against Kamal's tag. It must not
  // change the token, or a health endpoint that reports a build timestamp would invalidate
  // every plan the moment it was displayed.
  assert.equal(
    planToken({ ...base, servingVersion: "aaa" } as never),
    planToken({ ...base, servingVersion: "bbb" } as never),
  )
})

test("the token is stable across property order", () => {
  const reordered = {
    sqlDigest: base.sqlDigest,
    migrations: base.migrations,
    currentImageTag: base.currentImageTag,
    imageTag: base.imageTag,
    url: base.url,
    env: base.env,
    sqlPreview: base.sqlPreview,
    destructive: base.destructive,
    lastVerifiedBackup: base.lastVerifiedBackup,
  }
  assert.equal(planToken(base), planToken(reordered as never))
})
