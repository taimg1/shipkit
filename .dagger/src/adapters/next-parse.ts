import type { TestSummary } from "./types.js"

/**
 * Pure parsing of Node tool output — no Dagger, no containers, no I/O.
 *
 * Same rule as dotnet-parse.ts: output formats are exactly the thing that changes under you
 * between tool versions, so the parser lives where it can be unit-tested against real output.
 * Every case below was taken from vitest 4.1 running in the fixture.
 */

/** Colour codes. Absent when vitest writes to a pipe, present when something gives it a TTY. */
const ANSI = /\u001b\[[0-9;]*m/g

/**
 * The counts vitest prints, e.g.
 *   Test Files  1 failed | 1 passed (2)
 *        Tests  1 failed | 3 passed | 1 skipped | 1 todo (6)
 *
 * The parenthesised number is vitest's own total and is used as-is rather than summed: it is
 * the runner's count, and re-deriving it would be the kit inventing a second opinion.
 *
 * Returns zeros — not null — for the two shapes that mean "nothing ran":
 *   `Tests  no tests`, which a file containing no test at all produces, **exiting 0**; and
 *   `No test files found`, which `--passWithNoTests` produces, also exiting 0.
 * Both would otherwise be a green stage that tested nothing. The counts say what happened;
 * deciding that zero tests is a failure stays the core's call (index.ts, gates.ts).
 *
 * Null means the output carried no counts at all — a run that died before reporting.
 *
 * A file that fails to import is counted by vitest as a failed test FILE and not as a failed
 * test (`Test Files 1 failed | 1 passed` above `Tests 2 passed`). Those counts are left as
 * vitest reports them: that run exits non-zero, so the core reports the failing run itself
 * rather than a summary that only describes the files which did load.
 */
export function parseVitestSummary(raw: string): TestSummary | null {
  const text = raw.replace(ANSI, "")

  // The last one: `vitest run` prints one summary block, but a rerun or a merged stream can
  // carry an earlier one, and the final block is the one that describes the whole run.
  let line: string | null = null
  for (const l of text.split("\n")) {
    if (/^\s*Tests\s+\S/.test(l)) line = l.trim()
  }

  if (line === null) {
    return /No test files found/.test(text) ? empty() : null
  }
  if (/^Tests\s+no tests\b/.test(line)) return empty()

  const total = /\((\d+)\)\s*$/.exec(line)
  if (!total) return null

  const summary: TestSummary = { passed: 0, failed: 0, skipped: 0, total: Number(total[1]) }
  for (const [, count, outcome] of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)\b/g)) {
    const n = Number(count)
    if (outcome === "passed") summary.passed += n
    else if (outcome === "failed") summary.failed += n
    // A todo is a test that was declared and not run, which is what skipped already means here.
    else summary.skipped += n
  }
  return summary
}

const empty = (): TestSummary => ({ passed: 0, failed: 0, skipped: 0, total: 0 })

/**
 * The counts Playwright prints at the end of a run, e.g.
 *   1 failed
 *   1 flaky
 *   2 skipped
 *   7 passed (12.4s)
 *
 * Unlike vitest there is no parenthesised total, so this one is a sum of the lines the runner
 * printed — still the runner's own counts, never a re-derivation from the test list.
 *
 * `flaky` is a test that failed and then passed on a retry: the run exits 0, so it counts as
 * passed. `interrupted` counts as failed and `did not run` as skipped, which is what they are.
 *
 * Returns zeros — not null — for `No tests found`, which is what Playwright says when its
 * testDir or its filter matches nothing. Whether zero tests is a failure stays the core's
 * call (core/e2e.ts, gates.ts): with `--pass-with-no-tests` that run exits 0, which is exactly
 * the green-gate-that-checked-nothing this has to be able to report.
 *
 * Null means the output carried no counts at all — a run that died before reporting.
 */
export function parsePlaywrightSummary(raw: string): TestSummary | null {
  const text = raw.replace(ANSI, "")

  const summary: TestSummary = { passed: 0, failed: 0, skipped: 0, total: 0 }
  let sawCounts = false
  for (const l of text.split("\n")) {
    // The whole line, so that a test name containing "2 passed" cannot be read as a count.
    const m = /^(\d+)\s+(passed|failed|flaky|skipped|interrupted|did not run)(\s+\([^)]*\))?$/.exec(l.trim())
    if (!m) continue
    sawCounts = true
    const n = Number(m[1])
    if (m[2] === "passed" || m[2] === "flaky") summary.passed += n
    else if (m[2] === "failed" || m[2] === "interrupted") summary.failed += n
    else summary.skipped += n
    summary.total += n
  }

  if (sawCounts) return summary
  return /No tests found/.test(text) ? empty() : null
}
