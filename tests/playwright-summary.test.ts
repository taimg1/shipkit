import { test } from "node:test"
import assert from "node:assert/strict"
import { parsePlaywrightSummary } from "../.dagger/src/adapters/next-parse.ts"

/**
 * Every line below was printed by Playwright 1.63 in fixtures/next-app, running through the
 * `e2e` stage against the built image. Same rule as vitest-summary.test.ts: a parser tested
 * against invented output tests the invention.
 *
 * MIXED is assembled from two runs of that suite — the failing line from the run with a
 * deliberately wrong assertion, the passing line from the run without it — because the kit's
 * own report filters a failing run's output down to the lines that say what went wrong, and
 * the count of what passed is not one of them.
 */

const PASSED = `
Running 2 tests using 1 worker

  ✓  1 [chromium] › e2e/site.spec.ts:13:5 › the home page renders (170ms)
  ✓  2 [chromium] › e2e/site.spec.ts:18:5 › /orders renders the rows the seed put in the database (189ms)

  2 passed (1.1s)
`

const MIXED = `
Running 3 tests using 1 worker

  1) [chromium] › e2e/broken.spec.ts:2:5 › deliberately wrong, to prove the gate goes red

    Error: expect(locator).toHaveText(expected) failed

  1 failed
    [chromium] › e2e/broken.spec.ts:2:5 › deliberately wrong, to prove the gate goes red
  2 passed (1.4s)
`

/** Playwright's default when nothing matches: it says so, on stderr, and exits 1. */
const NONE = `
Error: No tests found
`

/**
 * The same thing under --pass-with-no-tests: nothing at all, and exit 0. This is the shape the
 * stage exists to refuse, and the parser can say nothing about it beyond "no counts".
 */
const SILENT = ""

test("a passing run reports the runner's own count", () => {
  assert.deepEqual(parsePlaywrightSummary(PASSED), { passed: 2, failed: 0, skipped: 0, total: 2 })
})

test("a mixed run keeps the two counts apart and totals them", () => {
  assert.deepEqual(parsePlaywrightSummary(MIXED), { passed: 2, failed: 1, skipped: 0, total: 3 })
})

// The test names in the failure list contain the word "failed"; only a whole line that is a
// count may be read as one.
test("a test name is not a count", () => {
  const summary = parsePlaywrightSummary(MIXED)
  assert.equal(summary?.total, 3, "a line from the failure listing was counted")
})

test("no tests found is zeros, not null: the core decides what that means", () => {
  assert.deepEqual(parsePlaywrightSummary(NONE), { passed: 0, failed: 0, skipped: 0, total: 0 })
})

test("output with no counts at all is null, and fails closed elsewhere", () => {
  assert.equal(parsePlaywrightSummary(SILENT), null)
  assert.equal(parsePlaywrightSummary("Error: browserType.launch: Executable doesn't exist"), null)
})

// A flaky test failed and then passed on a retry, and the run exits 0 — so it is a pass here.
// `interrupted` is a test that was stopped, and `did not run` one that never started.
test("the outcomes that are not simply passed or failed", () => {
  assert.deepEqual(parsePlaywrightSummary("  1 flaky\n  3 passed (2.0s)"), {
    passed: 4,
    failed: 0,
    skipped: 0,
    total: 4,
  })
  assert.deepEqual(parsePlaywrightSummary("  1 interrupted\n  2 did not run\n  1 passed (0.4s)"), {
    passed: 1,
    failed: 1,
    skipped: 2,
    total: 4,
  })
  assert.deepEqual(parsePlaywrightSummary("  2 skipped\n  1 passed (0.3s)"), {
    passed: 1,
    failed: 0,
    skipped: 2,
    total: 3,
  })
})

test("colour codes do not hide the counts", () => {
  const coloured = "\u001b[32m  2 passed\u001b[39m \u001b[2m(1.1s)\u001b[22m"
  assert.deepEqual(parsePlaywrightSummary(coloured), { passed: 2, failed: 0, skipped: 0, total: 2 })
})
