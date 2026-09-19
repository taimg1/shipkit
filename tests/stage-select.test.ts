import { test } from "node:test"
import assert from "node:assert/strict"
import { deployStageProblem, parseStages, selectedStages, stageRuns } from "../.dagger/src/core/stage-select.ts"

const CI = ["pre", "build", "test", "db", "push"]

test("no --stage runs the whole pipeline", () => {
  const sel = parseStages(undefined, CI)
  assert.equal(sel.selected, null)
  assert.deepEqual(sel.unknown, [])
  assert.ok(CI.every((s) => stageRuns(sel, s)))
})

test("one stage runs that stage and no other", () => {
  const sel = parseStages("test", CI)
  assert.ok(stageRuns(sel, "test"))
  assert.ok(!stageRuns(sel, "build"))
})

// The reason this function exists: split across CI jobs, push without build finds no image.
test("build and push can be selected together", () => {
  const sel = parseStages("build,push", CI)
  assert.deepEqual(sel.unknown, [])
  assert.ok(stageRuns(sel, "build"))
  assert.ok(stageRuns(sel, "push"))
  assert.ok(!stageRuns(sel, "test"))
})

test("surrounding whitespace is not part of a stage name", () => {
  const sel = parseStages("build, push", CI)
  assert.deepEqual(sel.unknown, [])
  assert.ok(stageRuns(sel, "push"))
})

// A name that matches nothing would run nothing and exit 0 — a green run that did no work.
test("an unknown stage is reported, never ignored", () => {
  assert.deepEqual(parseStages("tests", CI).unknown, ["tests"])
  assert.deepEqual(parseStages("build,nope", CI).unknown, ["nope"])
})

test("an empty --stage is refused rather than read as all or none", () => {
  assert.deepEqual(parseStages("", CI).unknown, [""])
})

// --- deploy stage sets (B7) ---

const DEPLOY = ["provision", "backup", "migrate", "release", "verify", "rollback", "clean"]
const sel = (spec?: string) => parseStages(spec, DEPLOY)

test("the stage list a token confirms is in pipeline order, and null for everything", () => {
  assert.equal(selectedStages(sel(), DEPLOY), null)
  assert.equal(selectedStages(sel(DEPLOY.join(",")), DEPLOY), null, "every stage named is the same as none")
  assert.deepEqual(selectedStages(sel("migrate,backup"), DEPLOY), ["backup", "migrate"])
})

test("the whole deploy is fine", () => {
  assert.equal(deployStageProblem(sel(), 3), null)
})

test("release without verify is refused, migrations or not", () => {
  assert.match(deployStageProblem(sel("release"), 0) ?? "", /without verify/)
  assert.match(deployStageProblem(sel("backup,migrate,release,clean"), 2) ?? "", /without verify/)
})

test("release without migrate is refused while migrations are pending", () => {
  assert.match(deployStageProblem(sel("release,verify,rollback"), 2) ?? "", /without migrate while 2/)
  assert.equal(deployStageProblem(sel("release,verify,rollback"), 0), null, "nothing pending: a code-only release")
})

test("migrate without backup is refused while migrations are pending", () => {
  assert.match(deployStageProblem(sel("migrate"), 1) ?? "", /without backup/)
})

test("read-only and partial sets that skip no gate are fine", () => {
  assert.equal(deployStageProblem(sel("backup"), 5), null)
  assert.equal(deployStageProblem(sel("verify"), 5), null)
  assert.equal(deployStageProblem(sel("backup,migrate"), 5), null)
  assert.equal(deployStageProblem(sel("clean"), 5), null)
})
