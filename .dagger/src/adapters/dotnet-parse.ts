import type { TestSummary } from "./types.js"

/**
 * Pure parsing of .NET tool output — no Dagger, no containers, no I/O.
 *
 * Every adapter should keep its parsers here rather than inline: output formats are exactly
 * the thing that changes under you between tool versions, and a parser that cannot be
 * unit-tested is a parser nobody notices breaking.
 */

/**
 * Parses the summary line `dotnet test` prints, e.g.
 *   Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 3 s
 *
 * Multiple test projects each print their own line, so counts are summed. Returns null when
 * no summary was printed at all — the core treats that as a failure, because a run that
 * discovers nothing still exits 0.
 */
export function parseDotnetTestSummary(raw: string): TestSummary | null {
  const re = /Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/g
  const totals: TestSummary = { passed: 0, failed: 0, skipped: 0, total: 0 }
  let m: RegExpExecArray | null
  let seen = false

  while ((m = re.exec(raw)) !== null) {
    seen = true
    totals.failed += Number(m[1])
    totals.passed += Number(m[2])
    totals.skipped += Number(m[3])
    totals.total += Number(m[4])
  }

  return seen ? totals : null
}

/**
 * Extracts migration ids from `dotnet ef migrations list`.
 *
 * When the database is unreachable — the normal case in CI — EF prints connection warnings
 * and a trailing note about pending status around the ids. Matching EF's timestamp format is
 * what separates data from that noise.
 */
export function parseMigrationList(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d{14}_/.test(l))
}

/**
 * Migrations after `from`, or null when `from` is not in the list.
 *
 * Null is not "everything is pending". An unknown `from` means the database (or the base
 * branch) has a migration this commit does not know — production is ahead of it, or the
 * histories diverged. Treating that as "everything pending" generated a script from an id EF
 * cannot find, and a migrate report claiming every migration was applied (B12). The adapter
 * turns null into an error; this stays pure so the rule is testable without Dagger.
 */
export function migrationsAfter(ids: string[], from: string | null): string[] | null {
  if (!from) return ids
  const idx = ids.indexOf(from)
  return idx < 0 ? null : ids.slice(idx + 1)
}

/**
 * The version a project targets, from its `<TargetFramework>`: `net9.0` -> `9.0`.
 *
 * It selects the SDK image, the runtime image the migration bundle runs in, and the
 * dotnet-ef major version. Getting it wrong fails deep inside a container with a message
 * about a missing SDK, so it is worth reading from the project rather than assuming.
 *
 * `<TargetFrameworks>` (plural) is not handled: a project that multi-targets has no single
 * answer, and guessing one would be worse than saying so.
 */
export function parseTargetFramework(csproj: string): string | null {
  if (/<TargetFrameworks>/i.test(csproj)) return null
  const tfm = /<TargetFramework>\s*net(\d+\.\d+)\s*<\/TargetFramework>/i.exec(csproj)
  return tfm?.[1] ?? null
}

/**
 * Where MSBuild would look for a project's properties, in the order that decides them: the
 * project file, then `Directory.Build.props` from the project's directory up to the root.
 * MSBuild imports only the nearest props file, and a property set in the project overrides it.
 *
 * `projectDir` is relative to the source root, e.g. `Api` or `src/Api`.
 */
export function targetFrameworkSources(projectDir: string, csprojName: string): string[] {
  const parts = projectDir.split("/").filter((p) => p && p !== ".")
  const props: string[] = []
  for (let i = parts.length; i >= 0; i--) {
    props.push([...parts.slice(0, i), "Directory.Build.props"].join("/"))
  }
  return [[...parts, csprojName].join("/"), ...props]
}

export type TargetFrameworkResolution =
  | { version: string; from: string }
  | { version: null; reason: string }

/**
 * The target framework, from the first file that declares one.
 *
 * `files` are in `targetFrameworkSources` order; a file that does not exist is simply absent.
 * A project that sets it in Directory.Build.props — common, and exactly what EasyTransfer does —
 * used to read as "could not read TargetFramework" and pass the check anyway (#8).
 */
export function resolveTargetFramework(files: { path: string; text: string }[]): TargetFrameworkResolution {
  for (const { path, text } of files) {
    if (/<TargetFrameworks>/i.test(text)) {
      return { version: null, reason: `${path} multi-targets (<TargetFrameworks>); there is no single version to check` }
    }
    const version = parseTargetFramework(text)
    if (version) return { version, from: path }
  }
  return { version: null, reason: `no <TargetFramework> in ${files.map((f) => f.path).join(", ") || "any project file"}` }
}
