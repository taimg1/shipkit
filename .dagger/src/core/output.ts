/**
 * What a failing command said, reduced to what a reader needs — without hiding how much was cut.
 *
 * Pure, so it can be tested without Dagger. The report used to keep the last 20 "interesting"
 * lines and say nothing else: `dotnet format` on a real project showed 20 of 56 errors, and the
 * real count had to be found by running the tool again locally (#9).
 */

/** Lines that actually say what went wrong, preferred over surrounding build chatter. */
const INTERESTING = /\b(error|failed|Failed!|Unhandled exception|warning as error)\b/i

/**
 * Compiler-style diagnostics: `path(line,col): error CODE: message`.
 *
 * The format MSBuild, `dotnet format`, csc and tsc all print, so this is not one stack's
 * knowledge. The code may be letters only (`WHITESPACE`) or letters and digits (`CS8604`).
 */
const DIAGNOSTIC = /^\s*(\S.*?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Za-z]+\d*)\s*:/

/** Kept in the run file when the rendered output is cut. Enough for any build, bounded for a log. */
const FULL_OUTPUT_CAP = 2000

export interface Diagnostics {
  errors: number
  warnings: number
  /** Distinct files with at least one diagnostic, most affected first. */
  files: { path: string; count: number }[]
  /** Diagnostic codes and how often each occurred. */
  codes: Record<string, number>
}

export interface OutputSummary {
  output: string[]
  /** Lines of the selected output that are not shown. Zero when nothing was cut. */
  omitted: number
  /** Everything, deduplicated, when something was cut — for the run file, not the terminal. */
  fullOutput?: string[]
  diagnostics?: Diagnostics
}

export function summarizeOutput(stdout: string, stderr: string, maxLines = 20): OutputSummary {
  // Both streams: .NET writes build and test failures to stdout, not stderr.
  const all = dedupe(
    `${stderr}\n${stdout}`
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0),
  )

  const interesting = all.filter((l) => INTERESTING.test(l))
  const chosen = interesting.length > 0 ? interesting : all
  const output = chosen.slice(-maxLines)
  const omitted = chosen.length - output.length

  const summary: OutputSummary = { output, omitted }
  if (omitted > 0) summary.fullOutput = all.slice(-FULL_OUTPUT_CAP)

  const diagnostics = parseDiagnostics(all)
  if (diagnostics) summary.diagnostics = diagnostics
  return summary
}

/**
 * `dotnet build` prints every error twice — inline, then again in the closing summary. Exact
 * duplicates are dropped, keeping the first, so the window shows more distinct lines.
 */
function dedupe(lines: string[]): string[] {
  const seen = new Set<string>()
  return lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)))
}

export function parseDiagnostics(lines: string[]): Diagnostics | undefined {
  const seen = new Set<string>()
  const files = new Map<string, number>()
  const codes: Record<string, number> = {}
  let errors = 0
  let warnings = 0

  for (const line of lines) {
    const m = DIAGNOSTIC.exec(line)
    if (!m) continue
    const [, path, row, col, level, code] = m
    // The same diagnostic can appear twice with a different trailing project suffix.
    const key = `${path}(${row},${col}):${level}:${code}`
    if (seen.has(key)) continue
    seen.add(key)

    if (level === "error") errors++
    else warnings++
    files.set(path, (files.get(path) ?? 0) + 1)
    codes[code] = (codes[code] ?? 0) + 1
  }

  if (seen.size === 0) return undefined

  const paths = trimCommonDirectory([...files.keys()])
  return {
    errors,
    warnings,
    files: [...files.entries()]
      .map(([path, count], i) => ({ path: paths[i], count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    codes,
  }
}

/**
 * `/src/Domain/A.cs`, `/src/Tests/B.cs` -> `Domain/A.cs`, `Tests/B.cs`.
 *
 * Only the container's mount point — the first directory of an absolute path, when every file
 * shares it — is noise. Trimming the whole common prefix would reduce a single file to its bare
 * name and lose where it lives.
 */
function trimCommonDirectory(paths: string[]): string[] {
  if (paths.length === 0 || !paths.every((p) => p.startsWith("/"))) return paths
  const first = (p: string) => p.split("/")[1]
  const mount = first(paths[0])
  if (!paths.every((p) => first(p) === mount && p.split("/").length > 3)) return paths
  return paths.map((p) => p.slice(mount.length + 2))
}
