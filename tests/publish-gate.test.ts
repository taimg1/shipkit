import { test } from "node:test"
import assert from "node:assert/strict"
import { imageTag, isCommitSha, publishDecision, publishedDigest } from "../.dagger/src/core/publish-gate.ts"

const SHA = "f6917afc0de1234567890abcdef1234567890abc"
const base = { publish: true, defaultBranch: "main", branch: "main", sha: SHA, dirty: false, built: true }

test("the default branch, a real commit and a built image publish", () => {
  assert.deepEqual(publishDecision(base), { action: "push" })
})

// B6 / C10 / D-8: `dagger call ci` without --branch used to publish. Unknown is not "main".
test("an unknown branch is refused, not waved through", () => {
  const d = publishDecision({ ...base, branch: undefined })
  assert.equal(d.action, "refuse")
  assert.match((d as { reason: string }).reason, /branch being built is unknown/)
  assert.equal(publishDecision({ ...base, branch: "" }).action, "refuse")
})

test("another branch is a normal skip, not a failure", () => {
  const d = publishDecision({ ...base, branch: "feature/x" })
  assert.deepEqual(d, { action: "skip", reason: 'branch "feature/x" is not main' })
})

test("what the wrapper sends for a pull request is never the default branch", () => {
  assert.equal(publishDecision({ ...base, branch: "pull_request:refs/pull/7/merge" }).action, "skip")
})

// B6: the default `sha = "dev"` published `sha-dev`, a tag every such run overwrote.
test("a sha that is not a full commit is refused", () => {
  for (const sha of ["dev", "f6917af", SHA.toUpperCase(), `${SHA}0`, ""]) {
    const d = publishDecision({ ...base, sha })
    assert.equal(d.action, "refuse", sha)
  }
})

test("publish: false skips before anything else is looked at", () => {
  assert.equal(publishDecision({ ...base, publish: false, branch: undefined, sha: "dev" }).action, "skip")
})

test("a dirty build on the default branch is refused", () => {
  assert.match((publishDecision({ ...base, dirty: true }) as { reason: string }).reason, /uncommitted/)
})

test("push without build has nothing to publish", () => {
  assert.deepEqual(publishDecision({ ...base, built: false }), {
    action: "skip",
    reason: "no image was built in this run",
  })
})

test("a full commit SHA is 40 lowercase hex characters", () => {
  assert.ok(isCommitSha(SHA))
  assert.ok(!isCommitSha("dev"))
  assert.ok(!isCommitSha(SHA.slice(0, 7)))
})

// C13: seven characters collide on a large repository; the tag must name exactly one commit.
test("the image tag carries the whole commit", () => {
  assert.equal(imageTag(SHA), `sha-${SHA}`)
  assert.equal(imageTag(SHA, true), `sha-${SHA}-dirty`)
})

test("the digest is read from the address publish() returns", () => {
  const digest = `sha256:${"a".repeat(64)}`
  assert.equal(publishedDigest(`ghcr.io/o/api:sha-${SHA}@${digest}`), digest)
  assert.equal(publishedDigest(`ghcr.io/o/api:sha-${SHA}`), null)
})
