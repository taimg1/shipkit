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
