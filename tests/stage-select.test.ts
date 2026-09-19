import { test } from "node:test"
import assert from "node:assert/strict"
import { deploySelectionProblem, parseStages, stageRuns } from "../.dagger/src/core/stage-select.ts"

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

// D-06: names that are stages of `deploy` and still cannot be asked for on their own.
const DEPLOY = ["provision", "backup", "migrate", "release", "verify", "rollback", "clean"]
const BOOT = ["boot the database accessory (first deploy to this server)"]

test("rollback is refused as a selection, alone or with others", () => {
  assert.match(deploySelectionProblem(parseStages("rollback", DEPLOY), [])!.message, /rollback cannot be selected/)
  assert.notEqual(deploySelectionProblem(parseStages("verify,rollback", DEPLOY), []), null)
})

test("a full deploy has nothing to refuse, provisioning or not", () => {
  assert.equal(deploySelectionProblem(parseStages(undefined, DEPLOY), BOOT), null)
})

test("a selection that skips provisioning the plan needs is refused", () => {
  assert.match(deploySelectionProblem(parseStages("migrate", DEPLOY), BOOT)!.message, /leaves provision out/)
})

test("provision selected, or nothing to provision, is fine", () => {
  assert.equal(deploySelectionProblem(parseStages("provision,migrate", DEPLOY), BOOT), null)
  assert.equal(deploySelectionProblem(parseStages("migrate", DEPLOY), []), null)
  assert.equal(deploySelectionProblem(parseStages("provision", DEPLOY), []), null)
})
