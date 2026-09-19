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

/**
 * The marker as the gates suggest it. One definition, so the advice a failing gate prints and
 * the pattern above cannot drift apart again — they did: the gate once suggested a
 * `shipkit:destructive-ok` marker that nothing read (B17).
 */
export const ALLOW_LOSS_EXAMPLE = "-- shipkit:allow-loss <table>.<column>  <reason>"

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

/** A PostgreSQL identifier: quoted (case kept, `""` escapes a quote) or bare (folded to lower case). */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`
/** An identifier with an optional schema: `orders`, `public."Orders"`. */
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`

/** What PostgreSQL makes of an identifier as written — `"CreatedAt"` → `CreatedAt`, `Orders` → `orders`. */
function identName(raw: string): string {
  const t = raw.trim()
  return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase()
}

/** The table a possibly schema-qualified name refers to, without the schema — as the snapshot names it. */
function tableName(qualified: string): string {
  const parts = qualified.match(new RegExp(IDENT, "g")) ?? [qualified]
  return identName(parts[parts.length - 1])
}

/**
 * What one statement line destroys or renames, as allow-loss targets: `orders` for a table,
 * `orders.CreatedAt` for a column. Null when the line cannot be read that way — and a line
 * that cannot be read is never waived.
 */
export function statementTargets(line: string): string[] | null {
  const clean = stripNoise(line)

  const drop = new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED}(?:\s*,\s*${QUALIFIED})*)`, "i").exec(clean)
  if (drop) {
    return drop[1].split(new RegExp(String.raw`\s*,\s*(?=${IDENT})`)).map(tableName)
  }

  const alter = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})([\s\S]*)$`, "i").exec(clean)
  if (!alter) return null
  const table = tableName(alter[1])
  const rest = alter[2]

  const columns: string[] = []
  const column = new RegExp(
    String.raw`\b(?:DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?|ALTER\s+COLUMN\s+|RENAME\s+COLUMN\s+)(${IDENT})`,
    "gi",
  )
  for (const m of rest.matchAll(column)) columns.push(`${table}.${identName(m[1])}`)
  return columns.length > 0 ? columns : [table]
}

/**
 * Whether the author named everything this line touches. Exact, never a substring: allowing
 * `orders.Id` must not allow dropping `invoices.CustomerId`, and allowing a table allows its
 * columns with it — the same rule unacknowledgedLosses applies to the apply-to-copy result.
 */
export function allowedByMarker(line: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false
  const targets = statementTargets(line)
  if (!targets || targets.length === 0) return false
  const set = new Set(allowed)
  return targets.every((t) => set.has(t) || set.has(t.split(".")[0]))
}

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
 * A finding is waived only when everything its own line touches is something the author
 * named (allowedByMarker). Squawk reports a line number, so the match is against that
 * statement rather than the whole file: a waiver for one column must not silence a different
 * drop elsewhere in the migration.
 */
export function applyAllowances(
  findings: Finding[],
  sqlText: string,
  allowed: string[],
): Finding[] {
  if (allowed.length === 0) return findings
  const lines = stripBom(sqlText).split("\n")

  return findings.filter((f) => {
    if (!WAIVABLE_SQUAWK_RULES.has(f.rule)) return true
    const line = f.line != null ? (lines[f.line - 1] ?? "") : ""
    return !allowedByMarker(line, allowed)
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
  const allowed = parseAllowedLosses(sqlText)

  lines.forEach((line, i) => {
    const clean = stripNoise(line)
    for (const d of DESTRUCTIVE) {
      if (!d.re.test(clean)) continue
      // A statement is waived only when it touches something the author named. A marker for
      // one column does not excuse dropping a different one in the same migration.
      if (allowedByMarker(line, allowed)) continue
      findings.push({ rule: d.rule, file: "migration.sql", line: i + 1, sql: line.trim() })
    }
  })
  return findings
}

/**
 * Squawk's exit code when it ran and found violations. Observed on squawk-cli 2.65.0: 0 with
 * `[]` on a clean file, 1 with a JSON array of violations otherwise.
 *
 * 1 is ALSO what it exits with when it did not lint anything — a missing file, a broken
 * `.squawk.toml` — and then stdout is empty and the reason is on stderr. So the exit code
 * alone never decides; the output has to agree with it.
 */
export const SQUAWK_VIOLATIONS_EXIT = 1

/**
 * Reads one Squawk run: its exit code and its JSON reporter output.
 *
 * Verified against squawk-cli 2.65.0. Each item carries:
 *   { file, line, column, level, message, help, rule_name, line_end, column_end }
 *
 * `line` is ZERO-BASED. Reporting it unchanged points the reader at the wrong line, which
 * for a linter is worse than reporting no line at all.
 *
 * Exactly two answers are a result: exit 0 with an array, and exit 1 with a non-empty array
 * of violations. Anything else — another exit code, empty stdout, output that is not the
 * reporter's shape — is reported as a finding rather than as a pass: a linter result we
 * cannot read is not a green light, and "Squawk printed nothing" used to read as "0 violations".
 */
export function parseSquawk(raw: string, exitCode: number, stderr = ""): Finding[] {
  const text = raw.trim()
  const failed = (why: string): Finding[] => [
    {
      rule: "squawk-did-not-run",
      message: `${why} (exit ${exitCode})${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
    },
  ]

  if (exitCode !== 0 && exitCode !== SQUAWK_VIOLATIONS_EXIT) return failed("Squawk exited with an unexpected code")
  if (text.length === 0) return failed("Squawk printed no report")

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return [{ rule: "squawk-output-unparseable", message: text.slice(0, 500) }]
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.every((i) => typeof i === "object" && i !== null && typeof (i as Record<string, unknown>).rule_name === "string")
  if (!valid) return [{ rule: "squawk-output-unparseable", message: text.slice(0, 500) }]

  const items = parsed as Record<string, unknown>[]
  // Violations reported with an exit code that says there were none, or the reverse: one of
  // the two is wrong, and the gate cannot know which.
  if (exitCode === SQUAWK_VIOLATIONS_EXIT && items.length === 0) {
    return failed("Squawk reported failure but listed no violations")
  }
  return items.map((i) => ({
    rule: String(i.rule_name),
    file: typeof i.file === "string" ? i.file : undefined,
    line: typeof i.line === "number" ? i.line + 1 : undefined,
    message: [i.message, i.help].filter(Boolean).join(" — ") || undefined,
  }))
}

/**
 * Which migration a line of a combined migration script belongs to.
 *
 * The db gate lints one script covering every pending migration, so Squawk and the scan report
 * a line in that script — `migration.sql:484` — which names nothing a developer can open (#5).
 *
 * Every migration's block ends by recording itself in the history table:
 *
 *   INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion")
 *   VALUES ('20260906150532_AddBlogPosts', '10.0.1');
 *
 * so a line belongs to the first such record at or after it. Column names vary with naming
 * conventions (`migration_id` under EFCore.NamingConventions), so only the table and the id
 * shape are matched. Lines after the last record (a trailing COMMIT) belong to the last one.
 *
 * `line` is one-based, as findings are. Returns undefined when the script records nothing.
 */
export function migrationForLine(sqlText: string, line: number, historyTable: string): string | undefined {
  const lines = stripBom(sqlText).split("\n")
  const records: { line: number; id: string }[] = []
  const table = historyTable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const insert = new RegExp(`INSERT\\s+INTO\\s+"?${table}"?`, "i")

  lines.forEach((text, i) => {
    if (!insert.test(text)) return
    // The id is on the INSERT line or within the VALUES that follow it.
    const window = lines.slice(i, i + 3).join("\n")
    const id = /'(\d{14}_[^']+)'/.exec(window)?.[1]
    if (id) records.push({ line: i + 1, id })
  })

  if (records.length === 0) return undefined
  return (records.find((r) => r.line >= line) ?? records[records.length - 1]).id
}
