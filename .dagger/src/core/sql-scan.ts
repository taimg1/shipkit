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

/**
 * The intent marker (decision D6). It travels inside the SQL, so it is visible in review.
 *
 *   -- shipkit:allow-loss orders.CreatedAt  column was never populated in production
 *
 * It must NAME what is being destroyed. A blanket "this migration is fine" would let a
 * second, unintended loss ride along inside a migration that was waived for a first one —
 * and the whole point of these gates is the loss nobody meant.
 *
 * The target is a table (`orders`) or a column (`orders.CreatedAt`).
 */
export const ALLOW_LOSS = /--\s*shipkit:allow-loss\s+([A-Za-z0-9_."]+)/gi

/** Targets the author has explicitly accepted losing, in file order. */
export function parseAllowedLosses(sqlText: string): string[] {
  const out: string[] = []
  for (const line of stripBom(sqlText).split("\n")) {
    const clean = stripNoise(line)
    for (const m of clean.matchAll(ALLOW_LOSS)) {
      out.push(m[1].replace(/"/g, ""))
    }
  }
  return out
}

/** The identifier a target ultimately names — `orders.CreatedAt` → `CreatedAt`. */
const leaf = (target: string) => target.split(".").pop() ?? target

/**
 * Squawk rules that an allow-loss marker may waive: the ones that say "you are removing or
 * renaming something clients depend on", which is exactly what the marker acknowledges.
 *
 * Without this, the marker would be unable to waive Squawk and an intentional, reviewed drop
 * could never ship — which in practice means the excluded_rules list grows instead, and the
 * rule is lost for every migration rather than for the one that was reviewed.
 */
export const WAIVABLE_SQUAWK_RULES = new Set([
  "ban-drop-column",
  "ban-drop-table",
  "ban-drop-database",
  "ban-drop-not-null",
  "renaming-column",
  "renaming-table",
])

/**
 * Drops findings that a marker has accounted for.
 *
 * A finding is waived only when its own line mentions something the author named. Squawk
 * reports a line number, so the match is against that statement rather than the whole file:
 * a waiver for one column must not silence a different drop elsewhere in the migration.
 */
export function applyAllowances(
  findings: Finding[],
  sqlText: string,
  allowed: string[],
): Finding[] {
  if (allowed.length === 0) return findings
  const names = allowed.map(leaf)
  const lines = stripBom(sqlText).split("\n")

  return findings.filter((f) => {
    if (!WAIVABLE_SQUAWK_RULES.has(f.rule)) return true
    const line = f.line != null ? (lines[f.line - 1] ?? "") : ""
    return !names.some((n) => stripNoise(line).includes(n))
  })
}

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

  // Noise is stripped before anything is matched. A marker inside a string literal — seeded
  // data, a comment column, a user-supplied value — must not disable the gate; that would be
  // a fail-open hole reachable by anyone who can write a row of test data.
  const allowed = parseAllowedLosses(sqlText).map(leaf)

  lines.forEach((line, i) => {
    const clean = stripNoise(line)
    for (const d of DESTRUCTIVE) {
      if (!d.re.test(clean)) continue
      // A statement is waived only when it touches something the author named. A marker for
      // one column does not excuse dropping a different one in the same migration.
      if (allowed.some((name) => clean.includes(name))) continue
      findings.push({ rule: d.rule, file: "migration.sql", line: i + 1, sql: line.trim() })
    }
  })
  return findings
}

/**
 * Parses Squawk's JSON reporter output.
 *
 * Verified against squawk-cli 2.65.0. Each item carries:
 *   { file, line, column, level, message, help, rule_name, line_end, column_end }
 *
 * `line` is ZERO-BASED. Reporting it unchanged points the reader at the wrong line, which
 * for a linter is worse than reporting no line at all.
 *
 * Unparseable output is reported as a finding rather than as a pass: a linter result we
 * cannot read is not a green light.
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
      line: typeof i.line === "number" ? i.line + 1 : undefined,
      message: [i.message, i.help].filter(Boolean).join(" — ") || undefined,
    }))
  } catch {
    return [{ rule: "squawk-output-unparseable", message: text.slice(0, 500) }]
  }
}
