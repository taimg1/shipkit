import type { Finding } from "../report.js"

/**
 * Pure SQL inspection — no Dagger, no containers, no I/O.
 *
 * Kept separate on purpose: this is the logic most likely to lose a client's data if it is
 * wrong, and this way it is unit-testable without Docker.
 */

/**
 * Statements that destroy data. EF generates DROP COLUMN + ADD COLUMN for a property
 * rename: the migration succeeds, CI is green, and the column's data is gone. This is the
 * single most likely way to lose client data with this stack (ci-cd-plan.md §7.3).
 */
export const DESTRUCTIVE = [
  { rule: "drop-column", re: /\bDROP\s+COLUMN\b/i },
  { rule: "drop-table", re: /\bDROP\s+TABLE\b/i },
  { rule: "alter-column-type", re: /\bALTER\s+COLUMN\b[\s\S]{0,80}?\bTYPE\b/i },
]

/** D6 — the intent marker travels inside the SQL, so it is visible in review. */
export const INTENT_MARKER = /--\s*shipkit:destructive-ok\b/i

/** Strips string literals and line comments so a marker or keyword inside them is ignored. */
function stripNoise(line: string): string {
  return line.replace(/'(?:''|[^'])*'/g, "''")
}

/** `dotnet ef migrations script` writes a UTF-8 BOM. Squawk and our scanners must not see it. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * True when the script contains no schema change beyond EF's own history-table bookkeeping.
 *
 * This matters because two very different situations produce the same near-empty file:
 * nothing is pending, or the assembly is stale and EF cannot see the new migration.
 * `dotnet ef migrations add` does NOT rebuild afterwards, so a stale assembly is easy to
 * produce — and it yields an empty script that Squawk passes. Cross-checking against the
 * migration list is what turns that silent pass into a failure.
 */
export function hasNoSchemaChange(sqlText: string): boolean {
  const body = stripBom(sqlText)
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trim())
    .filter((l) => l.length > 0)
    .join(" ")
    // EF emits the history table and its own INSERT bookkeeping in every script.
    .replace(/CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory"[\s\S]*?\);/i, "")
    .replace(/INSERT INTO "__EFMigrationsHistory"[\s\S]*?;/gi, "")

  return !/\b(CREATE|ALTER|DROP)\b/i.test(body)
}

export function scanDestructive(sqlText: string): Finding[] {
  const findings: Finding[] = []
  const lines = stripBom(sqlText).split("\n")

  // The marker applies to the whole script: a migration that declares intent has been
  // reviewed as a whole. Per-statement markers would be finer, but EF emits statements in
  // an order the author does not control, so anchoring to a line is unreliable.
  //
  // Noise is stripped FIRST. A marker inside a string literal — seeded data, a comment
  // column, a user-supplied value — must not disable the gate; that would be a fail-open
  // hole reachable by anyone who can write a row of test data.
  if (lines.some((l) => INTENT_MARKER.test(stripNoise(l)))) return findings

  lines.forEach((line, i) => {
    const clean = stripNoise(line)
    for (const d of DESTRUCTIVE) {
      if (d.re.test(clean)) {
        findings.push({ rule: d.rule, file: "migration.sql", line: i + 1, sql: line.trim() })
      }
    }
  })
  return findings
}

/**
 * Parses Squawk's JSON reporter output.
 *
 * UNVERIFIED against a real Squawk binary — the M3 checkpoint in docs/v1-plan.md exists to
 * confirm the flag and the field names. Unparseable output is reported as a finding rather
 * than as a pass: a linter result we cannot read is not a green light.
 */
export function parseSquawk(raw: string): Finding[] {
  const text = raw.trim()
  if (text.length === 0) return []
  try {
    const parsed = JSON.parse(text)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    return items.map((i: Record<string, unknown>) => ({
      rule: String(i.rule_name ?? i.rule ?? "unknown"),
      file: typeof i.file === "string" ? i.file : undefined,
      line: typeof i.line === "number" ? i.line : undefined,
      message: String(i.message ?? i.help ?? ""),
    }))
  } catch {
    return [{ rule: "squawk-output-unparseable", message: text.slice(0, 500) }]
  }
}
