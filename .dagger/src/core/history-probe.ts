/**
 * What production's migration history looks like, asked as its own question.
 *
 * Pure, so it can be tested without Dagger or a server. The history used to be read with one
 * query whose errors were thrown away: psql exits 0 on a SQL error unless told otherwise, stderr
 * went to /dev/null, and `|| true` caught the rest. Every failure to read — a column named
 * `migration_id` instead of `MigrationId`, a wrong container, no docker access — came back as
 * empty output, which meant "nothing applied, first deploy", and a deploy would plan every
 * migration against a populated database (#12).
 *
 * Now there are three answers, and only one of them means a first deploy.
 */

export type HistoryProbe =
  | { kind: "absent" }
  | { kind: "present"; column: string }
  | { kind: "unreadable"; reason: string }

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`

/**
 * One line saying whether the table exists, then one line per column. `to_regclass` answers
 * null for a missing table instead of raising, so "absent" is an answer, not an error.
 */
export function historyProbeSql(table: string): string {
  return [
    `select 'table:' || coalesce(to_regclass(quote_ident(${literal(table)}))::text, '');`,
    `select 'column:' || column_name from information_schema.columns ` +
      `where table_schema = current_schema() and table_name = ${literal(table)} order by ordinal_position;`,
  ].join("\n")
}

/**
 * Reads the probe's output.
 *
 * `candidates` are the id column names this stack can produce, in order of preference — EF's
 * default `MigrationId`, and `migration_id` under EFCore.NamingConventions. A history table with
 * neither is not guessed at.
 */
export function parseHistoryProbe(output: string, table: string, candidates: readonly string[]): HistoryProbe {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean)
  const tableLine = lines.find((l) => l.startsWith("table:"))

  // No answer to the first question means the query never ran — the most important case to
  // refuse, because it is exactly what empty output used to be mistaken for.
  if (tableLine === undefined) {
    return { kind: "unreadable", reason: `the database gave no answer about ${table}` }
  }
  if (tableLine === "table:") return { kind: "absent" }

  const columns = lines.filter((l) => l.startsWith("column:")).map((l) => l.slice("column:".length))
  const column = candidates.find((c) => columns.includes(c))
  if (!column) {
    return {
      kind: "unreadable",
      reason:
        `${table} exists but has none of the expected id columns ` +
        `(${candidates.join(", ")}); found: ${columns.join(", ") || "no columns"}`,
    }
  }
  return { kind: "present", column }
}

/** The newest applied migration, once the column is known. */
export function lastAppliedSql(table: string, column: string): string {
  return `select ${ident(column)} from ${ident(table)} order by ${ident(column)} desc limit 1;`
}
