import { test } from "node:test"
import assert from "node:assert/strict"
import { parseVitestSummary } from "../.dagger/src/adapters/next-parse.ts"

/**
 * Every sample below is real output from vitest 4.1 in fixtures/next-app, captured by running
 * the case it describes. A parser tested against invented output tests the invention.
 */

const PASSED = `
 RUN  v4.1.11 /src

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  15:56:46
   Duration  110ms (transform 13ms, setup 0ms, import 20ms, tests 2ms, environment 0ms)
`

const MIXED = `
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed | 1 skipped | 1 todo (6)
   Start at  15:57:08
   Duration  127ms
`

/** A test file that contains no test at all. This run exits 0. */
const NO_TESTS_IN_FILE = `
 Test Files  1 passed (1)
      Tests  no tests
   Start at  15:57:34
   Duration  94ms
`

/** \`--passWithNoTests\` with nothing matching. Also exits 0. */
const NO_TEST_FILES = `No test files found, exiting with code 0

filter:  zzz-nothing
include: **/*.test.ts, **/*.test.tsx
exclude:  node_modules, .next
`

test("reads vitest's own counts", () => {
  assert.deepEqual(parseVitestSummary(PASSED), { passed: 2, failed: 0, skipped: 0, total: 2 })
})

test("counts failures, and folds todo into skipped", () => {
  assert.deepEqual(parseVitestSummary(MIXED), { passed: 3, failed: 1, skipped: 2, total: 6 })
})

test("the total is vitest's, not a sum the kit made up", () => {
  // Contrived, but it is what decides whether the kit ever second-guesses the runner.
  const odd = " Tests  1 passed (7)\n"
  assert.equal(parseVitestSummary(odd)?.total, 7)
})

test("a run that discovered nothing reports zero tests, not nothing", () => {
  // Both of these exit 0. Reported as null they would be "no summary"; reported as zeros the
  // core can say the run tested nothing, which is what it does with them (gates.ts).
  for (const [name, raw] of [["no tests in the file", NO_TESTS_IN_FILE], ["no test files", NO_TEST_FILES]] as const) {
    assert.deepEqual(parseVitestSummary(raw), { passed: 0, failed: 0, skipped: 0, total: 0 }, name)
  }
})

test("output with no counts at all is null, so the core refuses it", () => {
  assert.equal(parseVitestSummary(""), null)
  assert.equal(parseVitestSummary("Error: Cannot find module 'vitest/config'\n"), null)
})

test("colour codes do not hide the counts", () => {
  const coloured = " \u001b[1mTests\u001b[22m  \u001b[1m\u001b[32m2 passed\u001b[39m\u001b[22m \u001b[90m(2)\u001b[39m\n"
  assert.deepEqual(parseVitestSummary(coloured), { passed: 2, failed: 0, skipped: 0, total: 2 })
})

test("the last summary wins when a stream carries more than one", () => {
  assert.equal(parseVitestSummary(PASSED + MIXED)?.total, 6)
})

test("a failed test FILE with no failed test leaves the counts as vitest reported them", () => {
  // An import error: the file never ran, so vitest counts it under Test Files and not under
  // Tests. The run exits non-zero, which is what fails the stage; the counts do not pretend
  // to describe the file that did not load.
  const collectError = `
 Test Files  1 failed | 1 passed (2)
      Tests  2 passed (2)
`
  assert.deepEqual(parseVitestSummary(collectError), { passed: 2, failed: 0, skipped: 0, total: 2 })
})
