import { test } from "node:test"
import assert from "node:assert/strict"
import { CI_STAGE_ORDER, DEPLOY_STAGE_ORDER, mergeStages, parseJobResults, renderSummary, unsuccessfulJobs } from "../bin/summary.mjs"

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

// A stage this table does not know about is appended after the last one it does, so an `e2e`
// missing from the order would be rendered below `push` — reading as if the browser suite ran
// after the image was published, which is the one thing about its position that matters.
test("e2e is rendered where it runs: after test, before db and push", () => {
  assert.deepEqual(CI_STAGE_ORDER, ["pre", "build", "test", "e2e", "db", "push"])
  const merged = mergeStages([jobReport("push", {}), jobReport("e2e", {})])
  assert.deepEqual(merged.map((s: { name: string }) => s.name), CI_STAGE_ORDER)
})

// The suite's count reaches the table through the same `tests` field the test stage uses, so a
// suite that quietly stopped discovering specs is a 0 in the summary rather than a green row.
test("the e2e row carries the count the stage reported", () => {
  const out = renderSummary([jobReport("e2e", { tests: { total: 64, passed: 64, failed: 0 } })])
  assert.match(out, /\| `e2e` \|.*64\/64 passed/)
})

// Not configured is not ok. The reason is what a reader needs: the project has no browser
// coverage, and that is a choice somebody made, not a stage that had nothing to do.
test("an e2e stage with no configuration renders its reason", () => {
  const skipped = jobReport("pre", {})
  skipped.stages = skipped.stages.map((s) =>
    s.name === "e2e" ? { name: "e2e", status: "skipped", reason: "not configured" } : s,
  )
  assert.match(renderSummary([skipped]), /\| `e2e` \|.*not configured/)
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

// --- deploy reports (the unattended path) ---

/**
 * A finished deploy, as the module writes it: one report, its stages in pipeline order, with
 * the detail each stage carries on its entry.
 */
const deployReport = (stages: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  command: "deploy",
  sha: "f6917afc0de1234567890abcdef1234567890abc",
  ok: true,
  exitCode: 0,
  seconds: 210,
  stages,
  plan: { env: "prod", url: "https://api.client.com", imageTag: "sha-f6917af", token: "7f3a91c2e004" },
  ...extra,
})

const deployed = [
  { name: "provision", status: "skipped", reason: "server already provisioned" },
  { name: "backup", status: "ok", seconds: 41, backup: { status: "verified", path: "/var/backups/shipkit/api/f6917af-20260920T101500Z.pgc" } },
  { name: "migrate", status: "ok", seconds: 6, applied: ["20260918_AddOrdersIndex"] },
  { name: "release", status: "ok", seconds: 38, released: "sha-f6917af", previous: "sha-9f8e7d6" },
  { name: "verify", status: "ok", seconds: 9, verified: { version: "f6917afc0de1", attempts: 2 } },
  { name: "rollback", status: "skipped", reason: "not needed" },
  { name: "clean", status: "ok", seconds: 4, rollbackWindow: ["sha-9f8e7d6", "sha-1122334"] },
]

test("a deploy's stages are listed in deploy order, not in ci order", () => {
  const shuffled = [...deployed].reverse()
  const merged = mergeStages([deployReport(shuffled)])
  assert.deepEqual(merged.map((s: { name: string }) => s.name), DEPLOY_STAGE_ORDER)
})

// What a deploy did to production is not visible from a stage name and a tick: where the dump
// that could undo it is kept, which version is serving, and whether a rollback fired.
test("the deploy table says where the backup is, and what is serving", () => {
  const out = renderSummary([deployReport(deployed)], { title: "Deploy" })
  assert.match(out, /^## Deploy — ok/)
  assert.match(out, /prod \(https:\/\/api\.client\.com\)/)
  assert.match(out, /deployed `sha-f6917af`/)
  assert.match(out, /stored `\/var\/backups\/shipkit\/api\/f6917af-20260920T101500Z\.pgc`/)
  assert.match(out, /applied 20260918_AddOrdersIndex/)
  assert.match(out, /`sha-f6917af` \(was `sha-9f8e7d6`\)/)
  assert.match(out, /2 version\(s\) left to roll back to/)
})

test("a rollback that fired is on the table, not only in the log", () => {
  const rolledBack = deployed.map((s) =>
    s.name === "verify"
      ? { name: "verify", status: "failed", reason: "sha-9f8e7d6 is still answering /health" }
      : s.name === "rollback"
        ? { name: "rollback", status: "ok", seconds: 30, rolledBackTo: "sha-9f8e7d6", verified: { version: "9f8e7d6" } }
        : s,
  )
  const out = renderSummary([deployReport(rolledBack, { ok: false, exitCode: 1, error: "the release did not take" })], {
    title: "Deploy",
  })
  assert.match(out, /^## Deploy — failed/)
  assert.match(out, /rolled back to `sha-9f8e7d6`/)
})

// --- stopped for confirmation (exit 4) ---

const stoppedReport = () =>
  deployReport(
    [
      { name: "provision", status: "skipped", reason: "not selected" },
      { name: "backup", status: "skipped", reason: "previous stage failed" },
    ],
    {
      ok: false,
      exitCode: 4,
      error: "this plan drops a column, which no pipeline may approve on its own",
      rendered: "  target      prod  (https://api.client.com)\n  migrations  20260919_DropLegacy",
    },
  )

test("a deploy that stopped for a person is stopped, not failed", () => {
  // Nothing is broken and nothing was deployed. "failed" sends the reader looking for a fault.
  const out = renderSummary([stoppedReport()], { title: "Deploy" })
  assert.match(out, /^## Deploy — stopped/)
  assert.match(out, /Confirmation required/)
})

test("the summary carries the plan and the exact command that executes it", () => {
  // Exit 4 with the plan in a log nobody opens is a dead end: the run is red and the next step
  // is unknowable from the run page.
  const out = renderSummary([stoppedReport()], { title: "Deploy" })
  assert.match(out, /drops a column/)
  assert.match(out, /20260919_DropLegacy/)
  assert.match(out, /shipkit deploy --yes=7f3a91c2e004/)
})

test("a real failure outranks a stop, so one cannot hide the other", () => {
  const out = renderSummary([stoppedReport()], { title: "Deploy", jobs: { ci: { result: "failure" } } })
  assert.match(out, /^## Deploy — failed/)
})

test("a plan confirmed for some stages is confirmed with those stages", () => {
  const partial = stoppedReport()
  partial.plan = { ...partial.plan, stages: ["backup", "migrate"] }
  assert.match(renderSummary([partial]), /shipkit deploy --yes=7f3a91c2e004 --stage=backup,migrate/)
})
