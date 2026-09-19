import { test } from "node:test"
import assert from "node:assert/strict"
import { CI_STAGE_ORDER, mergeStages, parseJobResults, renderSummary, unsuccessfulJobs } from "../bin/summary.mjs"

/** What one job's report looks like: its own stage ran, the rest are placeholders. */
const jobReport = (name: string, stage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  command: "ci",
  sha: "f6917afc0de1234567890abcdef1234567890abc",
  ok: true,
  exitCode: 0,
  seconds: 30,
  stages: CI_STAGE_ORDER.map((s) =>
    s === name ? { name, status: "ok", seconds: 10, ...stage } : { name: s, status: "skipped", reason: "not selected" },
  ),
  ...extra,
})

// The bug this guards against: every report lists every stage, so a placeholder from one job
// can bury the job that actually ran that stage, and the summary claims nothing happened.
test("a stage that ran beats the same stage marked not selected elsewhere", () => {
  const merged = mergeStages([jobReport("pre", {}), jobReport("test", { tests: { total: 9, passed: 9, failed: 0 } })])
  const test_ = merged.find((s: { name: string }) => s.name === "test")
  assert.equal(test_.status, "ok")
  assert.equal(merged.find((s: { name: string }) => s.name === "pre").status, "ok")
})

test("a failure outranks everything, so it cannot be merged away", () => {
  const failing = jobReport("test", {})
  failing.stages = failing.stages.map((s) =>
    s.name === "test" ? { name: "test", status: "failed", reason: "2 of 9 failed" } : s,
  )
  const merged = mergeStages([jobReport("test", {}), failing])
  assert.equal(merged.find((s: { name: string }) => s.name === "test").status, "failed")
})

// "db=none" says something; "not selected" says only that another job had the job.
test("a skip with a real reason beats a skip that means nothing", () => {
  const meaningful = jobReport("pre", {})
  meaningful.stages = meaningful.stages.map((s) =>
    s.name === "db" ? { name: "db", status: "skipped", reason: "db=none" } : s,
  )
  const merged = mergeStages([jobReport("test", {}), meaningful])
  assert.equal(merged.find((s: { name: string }) => s.name === "db").reason, "db=none")
})

test("stages are listed in pipeline order, not in the order the jobs finished", () => {
  const merged = mergeStages([jobReport("push", {}), jobReport("pre", {})])
  assert.deepEqual(merged.map((s: { name: string }) => s.name), CI_STAGE_ORDER)
})

test("the verdict is failed when any job failed", () => {
  const bad = { ...jobReport("test", {}), ok: false, error: "tests failed" }
  assert.match(renderSummary([bad]), /^## CI — failed/)
  assert.match(renderSummary([jobReport("test", {})]), /^## CI — ok/)
})

// A run can die before a single job writes a report. An empty, passing table would be a lie.
test("no reports is said out loud, not rendered as a green table", () => {
  const out = renderSummary([])
  assert.match(out, /No stage reports/)
  assert.doesNotMatch(out, /— ok/)
})

test("a pipe in a reason cannot break the table row", () => {
  const bad = jobReport("pre", {})
  bad.stages = bad.stages.map((s) =>
    s.name === "pre" ? { name: "pre", status: "failed", reason: "grep a|b failed\nsecond line" } : s,
  )
  const row = renderSummary([bad]).split("\n").find((l) => l.includes("`pre`"))!
  // Escaped, so the cell holds the text instead of opening a seventh column.
  assert.ok(row.includes("a\\|b"), row)
  // Six cells: leading empty, mark, stage, time, detail, trailing empty.
  assert.equal(row.replace(/\\\|/g, "").split("|").length, 6, row)
  assert.ok(row.includes("second line"))
})

test("the commit is shown short, and the image tag is carried through", () => {
  const out = renderSummary([jobReport("build", { tag: "sha-f6917af" })])
  assert.match(out, /`f6917af`/)
  assert.match(out, /`sha-f6917af`/)
})

test("a dirty tree is called out, because its image is never published", () => {
  assert.match(renderSummary([jobReport("build", {}, { dirty: true })]), /uncommitted changes/)
})

test("the title names the pipeline, so deploy and ci summaries are told apart", () => {
  assert.match(renderSummary([jobReport("pre", {})], { title: "Deploy" }), /^## Deploy — ok/)
})

// --- job results (D-10) ---

const needs = (results: Record<string, string>) =>
  Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { result, outputs: {} }]))

// The bug: `unit` writes no report. With only unit tests failing, every report said ok and the
// summary of a red workflow was headed "CI — ok".
test("a job that failed without a report fails the verdict", () => {
  const jobs = needs({ unit: "failure", analysis: "success", tests: "success", migrations: "success", image: "skipped" })
  const out = renderSummary([jobReport("pre", {}), jobReport("test", {})], { jobs })
  assert.match(out, /^## CI — failed/)
  assert.match(out, /`unit` \(failure\)/)
})

test("a cancelled job is not a pass either", () => {
  const out = renderSummary([jobReport("pre", {})], { jobs: needs({ unit: "success", tests: "cancelled" }) })
  assert.match(out, /^## CI — failed/)
  assert.match(out, /`tests` \(cancelled\)/)
})

test("all jobs succeeded and all reports ok is ok", () => {
  const out = renderSummary([jobReport("pre", {})], { jobs: needs({ unit: "success", analysis: "success" }) })
  assert.match(out, /^## CI — ok/)
  assert.doesNotMatch(out, /did not succeed/)
})

test("a skipped job on its own does not fail the verdict", () => {
  assert.deepEqual(unsuccessfulJobs(needs({ image: "skipped", unit: "success" })), [])
})

test("no reports and a failed job says failed, and which job", () => {
  const out = renderSummary([], { jobs: needs({ unit: "failure" }) })
  assert.match(out, /^## CI — failed/)
  assert.match(out, /`unit` \(failure\)/)
})

// Asked for and unreadable is not the same as not asked for.
test("job results that cannot be read fail the verdict", () => {
  assert.equal(parseJobResults("not json"), null)
  assert.equal(parseJobResults("[]"), null)
  assert.match(renderSummary([jobReport("pre", {})], { jobs: null }), /^## CI — failed/)
})

test("job results read from GitHub's toJSON(needs)", () => {
  const text = JSON.stringify(needs({ unit: "failure", tests: "success" }), null, 2)
  assert.deepEqual(unsuccessfulJobs(parseJobResults(text)), [{ name: "unit", result: "failure" }])
})

test("without job results the verdict is what the reports say, as before", () => {
  assert.match(renderSummary([jobReport("pre", {})]), /^## CI — ok/)
})
