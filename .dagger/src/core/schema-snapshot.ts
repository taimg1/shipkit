/**
 * Comparing a database before and after a migration — the strongest available mitigation for
 * the EF rename trap (ci-cd-plan.md §7.3).
 *
 * Squawk and the grep scan both read SQL and guess at intent. This one applies the migration
 * to a copy that has rows in it and looks at what survived. It is the only check here that
 * can tell "renamed the column" from "destroyed the column and made a new empty one", because
 * from the SQL those are the same shape.
 *
 * Written against information_schema, so nothing in this file is specific to EF Core or .NET.
 */

/** EF's own bookkeeping table gains a row per migration by design; it is not evidence. */
export const BOOKKEEPING_TABLES = ["__EFMigrationsHistory", "_prisma_migrations", "__drizzle_migrations"]

export interface Snapshot {
  /** "table.column" for every column in the public schema, sorted. */
  columns: string[]
  /** Exact row count per table. */
  rows: Record<string, number>
}

/**
 * One query returning the whole snapshot as JSON.
 *
 * Row counts come from query_to_xml rather than pg_stat_user_tables: the statistics view is
 * an estimate that needs ANALYZE to be meaningful, and an estimate cannot support an
 * assertion about lost rows.
 */
export const SNAPSHOT_SQL = `
select json_build_object(
  'columns', coalesce((
    select json_agg(x.c order by x.c)
    from (
      select table_name || '.' || column_name as c
      from information_schema.columns
      where table_schema = 'public'
    ) x
  ), '[]'::json),
  'rows', coalesce((
    select json_object_agg(s.table_name, s.cnt)
    from (
      select
        t.table_name,
        (xpath(
          '/row/cnt/text()',
          query_to_xml(
            format('select count(*) as cnt from %I.%I', t.table_schema, t.table_name),
            false, true, ''
          )
        ))[1]::text::bigint as cnt
      from information_schema.tables t
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
    ) s
  ), '{}'::json)
)::text;
`.trim()

export function parseSnapshot(raw: string): Snapshot {
  const text = raw.trim()
  if (text.length === 0) throw new Error("empty snapshot output")
  const parsed = JSON.parse(text) as { columns?: string[]; rows?: Record<string, number> }
  return {
    columns: parsed.columns ?? [],
    rows: Object.fromEntries(
      Object.entries(parsed.rows ?? {}).map(([k, v]) => [k, Number(v)]),
    ),
  }
}

const tableOf = (column: string) => column.split(".")[0]
const isBookkeeping = (table: string) => BOOKKEEPING_TABLES.includes(table)

/**
 * What the migration destroyed. An empty result means nothing that existed before is gone.
 *
 * Only losses are reported. New tables, new columns and new rows are what a migration is for;
 * the question this answers is narrower and more important: did anything that held data stop
 * existing, or stop holding it?
 */
export interface Loss {
  /** `orders` for a table, `orders.CreatedAt` for a column. Matched against allow-loss markers. */
  target: string
  message: string
}

export function findLosses(before: Snapshot, after: Snapshot): Loss[] {
  const losses: Loss[] = []

  const afterColumns = new Set(after.columns)
  const afterTables = new Set(Object.keys(after.rows))

  const lostTables = Object.keys(before.rows)
    .filter((t) => !isBookkeeping(t))
    .filter((t) => !afterTables.has(t))
  for (const t of lostTables) {
    losses.push({
      target: t,
      message: `table "${t}" no longer exists (held ${before.rows[t]} row(s))`,
    })
  }

  for (const c of before.columns) {
    const table = tableOf(c)
    if (isBookkeeping(table)) continue
    // A column in a table that was dropped is already reported above; do not report twice.
    if (lostTables.includes(table)) continue
    if (!afterColumns.has(c)) {
      const rows = before.rows[table] ?? 0
      losses.push({
        target: c,
        message:
          `column "${c}" no longer exists` +
          (rows > 0 ? ` (its table held ${rows} row(s) before the migration)` : ""),
      })
    }
  }

  for (const [table, countBefore] of Object.entries(before.rows)) {
    if (isBookkeeping(table)) continue
    if (!afterTables.has(table)) continue
    const countAfter = after.rows[table] ?? 0
    if (countAfter < countBefore) {
      losses.push({
        target: table,
        message: `table "${table}" lost rows: ${countBefore} before, ${countAfter} after`,
      })
    }
  }

  return losses
}

/**
 * Losses the author did not name in an allow-loss marker.
 *
 * Matching is on the exact target, not a substring: allowing `orders.CreatedAt` must not
 * quietly allow `orders.CreatedAtUtc`, and allowing a table allows its columns with it.
 */
export function unacknowledgedLosses(losses: Loss[], allowed: string[]): Loss[] {
  const set = new Set(allowed)
  return losses.filter((l) => {
    if (set.has(l.target)) return false
    const table = l.target.split(".")[0]
    return !set.has(table)
  })
}

/** Allowances that matched no actual loss — see the stale-allowance gate. */
export function staleAllowances(losses: Loss[], allowed: string[]): string[] {
  const lost = new Set<string>()
  for (const l of losses) {
    lost.add(l.target)
    lost.add(l.target.split(".")[0])
  }
  return allowed.filter((a) => !lost.has(a))
}
