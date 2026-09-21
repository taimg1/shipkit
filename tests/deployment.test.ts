import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deploymentStatus } from "../bin/deployment.mjs"
import { validateOptions } from "../bin/lib.mjs"

/**
 * The rule this file exists for: the state comes from the report, never from whether the job
 * reached its last step. A deployment marked `success` while `verify` failed and the release
 * was rolled back is worse than no record at all — it is the record people read during an
 * incident, and it would be telling them the wrong thing at the worst moment.
 *
 * So every shape a deploy report can arrive in is here: deployed and verified, a gate that
 * said no, a rollback that fired, exit 4, exit 2, and no report at all.
 */

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

const ENV = {
  GITHUB_SHA: SHA,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "client/api",
  GITHUB_RUN_ID: "42",
}

const PLAN = { env: "prod", url: "https://api.client.com", token: "7f3a91c2e004" }

/** A deploy report, with only the stages a case is about spelled out. */
const report = (over: Record<string, unknown> = {}) => ({
  command: "deploy",
  sha: SHA,
  ok: true,
  exitCode: 0,
  seconds: 120,
  plan: PLAN,
  stages: [
    { name: "backup", status: "ok" },
    { name: "migrate", status: "ok", applied: [] },
    { name: "release", status: "ok", released: `sha-${SHA}` },
    { name: "verify", status: "ok", verified: { version: SHA } },
    { name: "clean", status: "ok" },
  ],
  ...over,
})

const of = (r: unknown) => deploymentStatus([r], ENV)

test("a deploy that released and verified is a success", () => {
  const { status, deployment } = of(report())
  assert.equal(status.state, "success")
  // The environment and its URL are the client's, from shipkit.yaml, through the plan.
  assert.equal(deployment.environment, "prod")
  assert.equal(status.environment_url, "https://api.client.com")
  assert.equal(deployment.ref, SHA)
  assert.equal(status.log_url, "https://github.com/client/api/actions/runs/42")
})

// The one this whole file is a guard against.
test("a verify that failed and rolled back is a failure, and says what it rolled back to", () => {
  const rolled = report({
    ok: false,
    exitCode: 1,
    error: "/health still reports sha-0000000 after 60s",
    stages: [
      { name: "release", status: "ok", released: `sha-${SHA}` },
      { name: "verify", status: "failed", reason: "/health still reports sha-0000000 after 60s" },
      { name: "rollback", status: "ok", rolledBackTo: "sha-0000000" },
    ],
  })
  const { status } = of(rolled)
  assert.equal(status.state, "failure")
  assert.match(status.description, /rolled back to sha-0000000/)
  // Nothing this run put there is serving, so nothing invites a reader to go and look.
  assert.equal(status.environment_url, undefined)
})

test("a gate that said no is a failure naming the stage and the reason", () => {
  const gated = of(report({
    ok: false,
    exitCode: 1,
    error: "the backup could not be restored into a scratch database",
    stages: [
      { name: "backup", status: "failed", reason: "the backup could not be restored into a scratch database" },
      { name: "migrate", status: "skipped", reason: "previous stage failed" },
    ],
  }))
  assert.equal(gated.status.state, "failure")
  assert.match(gated.status.description, /^backup: the backup could not be restored/)
})

// Exit 4 is the kit stopping for a person. Nothing was touched, so nothing may claim a release
// — and `pending` would read as a deploy still in flight, which this one is not.
test("exit 4 is recorded as inactive, never as success", () => {
  const stopped = of(report({
    ok: false,
    exitCode: 4,
    error: "this deploy cannot approve itself: the pending migrations contain destructive SQL",
    stages: [{ name: "approve", status: "failed", reason: "the pending migrations contain destructive SQL" }],
  }))
  assert.equal(stopped.status.state, "inactive")
  assert.match(stopped.status.description, /stopped for confirmation/)
  assert.match(stopped.status.description, /destructive SQL/)
  assert.equal(stopped.status.environment_url, undefined)
  // The annotation is what a reader sees without opening anything; it has to point somewhere.
  assert.match(stopped.annotation, /^::warning title=Deploy stopped::/)
  assert.match(stopped.annotation, /summary/)
})

// Configuration, before the plan was ever built: no environment is known, and the default is
// the one `shipkit deploy` itself applies for --env.
test("exit 2 is a failure, and is recorded against the default environment", () => {
  const misconfigured = of({
    command: "deploy",
    sha: SHA,
    ok: false,
    exitCode: 2,
    seconds: 3,
    error: ".kamal/secrets refers to variables with no value: APP_DB_PASSWORD",
    stages: [],
  })
  assert.equal(misconfigured.status.state, "failure")
  assert.equal(misconfigured.deployment.environment, "prod")
  assert.match(misconfigured.status.description, /APP_DB_PASSWORD/)
})

test("no report at all is a failure, not a pass", () => {
  const nothing = deploymentStatus([], ENV)
  assert.equal(nothing.status.state, "failure")
  assert.match(nothing.status.description, /no deploy report/)
  // The workflow still has a commit to record against.
  assert.equal(nothing.deployment.ref, SHA)
  assert.match(nothing.annotation, /^::error title=Deploy failed::/)
})

// `collectReports` drops a file it cannot parse, so an unreadable report arrives here as no
// report. A report that parsed but carries nothing recognisable must not do better.
test("a report that is not a deploy, or is missing its verdict, never reads as success", () => {
  const ci = deploymentStatus([{ command: "ci", sha: SHA, ok: true, exitCode: 0, stages: [] }], ENV)
  assert.equal(ci.status.state, "failure")

  const planOnly = deploymentStatus([{ command: "deploy --plan", sha: SHA, ok: true, exitCode: 0, stages: [], plan: PLAN }], ENV)
  assert.equal(planOnly.status.state, "failure")

  const mangled = deploymentStatus([{ command: "deploy", sha: SHA, stages: [{ name: "verify", status: "ok" }] }], ENV)
  assert.equal(mangled.status.state, "failure")
})

// `--stage` can leave `verify` out. `--auto` refuses such a plan, but a hand-run deploy whose
// report ends up here must not be recorded as a verified release.
test("ok with no verify is inactive: nothing proved the release is serving", () => {
  const unverified = of(report({
    stages: [
      { name: "release", status: "ok", released: `sha-${SHA}` },
      { name: "verify", status: "skipped", reason: "not selected" },
    ],
  }))
  assert.equal(unverified.status.state, "inactive")
  assert.match(unverified.status.description, /nothing proves this release is serving/)
})

test("the deployment is created in a way that actually creates one", () => {
  const { deployment } = of(report())
  // Without this GitHub tries to merge the base branch in and answers 202 with no deployment.
  assert.equal(deployment.auto_merge, false)
  // Without this GitHub refuses while any check on the commit is running — and one always is:
  // the job posting this.
  assert.deepEqual(deployment.required_contexts, [])
  assert.equal(deployment.production_environment, true)
  assert.equal(deployment.transient_environment, false)
})

// GitHub truncates a longer description, and a workflow command is one line.
test("descriptions fit, and the annotation stays on one line", () => {
  const long = of(report({
    ok: false,
    exitCode: 1,
    error: `a reason that goes on and on ${"and on ".repeat(40)}\nwith a second line`,
    stages: [{ name: "migrate", status: "failed", reason: `x ${"y ".repeat(200)}\nz` }],
  }))
  assert.ok(long.status.description.length <= 140, long.status.description.length)
  assert.ok(!long.annotation.includes("\n"))
  assert.equal(long.deployment.description.length <= 140, true)
})

// Outside a GitHub runner there is no run to link to and no fallback SHA. The record still has
// to be well formed rather than carrying the string "undefined".
test("without the runner's environment the record is still well formed", () => {
  const bare = deploymentStatus([report()], {})
  assert.equal(bare.status.log_url, undefined)
  assert.equal(bare.deployment.ref, SHA)
  assert.equal(bare.status.state, "success")
})

/**
 * The flag, end to end. The mapping above is pure; this is the part that has to find the
 * reports, write two files a workflow can post without touching their contents, and — because
 * it runs on a job that has already failed — never fail itself.
 */
function runSummary(reports: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "shipkit-deployment-"))
  const reportDir = join(dir, "reports")
  mkdirSync(reportDir)
  reports.forEach((r, i) => writeFileSync(join(reportDir, `r${i}.json`), JSON.stringify(r)))
  const out = join(dir, "record")
  const r = spawnSync(process.execPath, ["bin/shipkit", "summary", reportDir, "--deployment-status", out], {
    encoding: "utf8",
    env: { ...process.env, ...ENV },
  })
  return { r, out }
}

test("the flag writes the two bodies gh api posts, and says nothing else on stdout", () => {
  const { r, out } = runSummary([report()])
  assert.equal(r.status, 0, r.stderr)
  const deployment = JSON.parse(readFileSync(join(out, "deployment.json"), "utf8"))
  const status = JSON.parse(readFileSync(join(out, "status.json"), "utf8"))
  assert.equal(deployment.environment, "prod")
  assert.equal(status.state, "success")
  // stdout is the annotation and only the annotation: the step pipes nothing else anywhere.
  assert.match(r.stdout.trim(), /^::notice title=Deployed::/)
  assert.equal(r.stdout.trim().split("\n").length, 1)
})

// This runs on a job whose deploy has already failed. Exiting non-zero here would turn "the
// deploy failed" into "the step that explains the failure failed", and the reason would be
// two screens further up.
test("a directory with no reports still writes a record and exits 0", () => {
  const { r, out } = runSummary([])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(join(out, "status.json"), "utf8")).state, "failure")
})

test("the flag belongs to summary and to nothing else", () => {
  assert.equal(validateOptions("summary", { _: ["summary", "reports"], "deployment-status": "out" }), undefined)
  // A bare --deployment-status would write the record into a directory called "true".
  assert.equal(validateOptions("summary", { _: ["summary", "reports"], "deployment-status": true })!.code, 2)
  assert.match(
    validateOptions("ci", { _: ["ci"], "deployment-status": "out" })!.message,
    /unknown option --deployment-status/,
  )
})
