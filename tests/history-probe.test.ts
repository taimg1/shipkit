import { test } from "node:test"
import assert from "node:assert/strict"
import { historyProbeSql, lastAppliedSql, parseHistoryProbe } from "../.dagger/src/core/history-probe.ts"

const TABLE = "__EFMigrationsHistory"
const EF = ["MigrationId", "migration_id"] as const

test("empty output is unreadable, never a first deploy", () => {
  // The fail-open this replaces: every read error used to come back as "".
  assert.equal(parseHistoryProbe("", TABLE, EF).kind, "unreadable")
})

test("a table that does not exist is a first deploy", () => {
  assert.deepEqual(parseHistoryProbe("table:\n", TABLE, EF), { kind: "absent" })
})

test("the default EF column is found", () => {
  const out = `table:"__EFMigrationsHistory"\ncolumn:MigrationId\ncolumn:ProductVersion\n`
  assert.deepEqual(parseHistoryProbe(out, TABLE, EF), { kind: "present", column: "MigrationId" })
})

test("the snake_case column from EFCore.NamingConventions is found", () => {
  // EasyTransfer's history table.
  const out = `table:"__EFMigrationsHistory"\ncolumn:migration_id\ncolumn:product_version\n`
  assert.deepEqual(parseHistoryProbe(out, TABLE, EF), { kind: "present", column: "migration_id" })
})

test("a history table with an unknown id column is refused, with what was found", () => {
  const r = parseHistoryProbe(`table:"__EFMigrationsHistory"\ncolumn:id\ncolumn:version\n`, TABLE, EF)
  assert.equal(r.kind, "unreadable")
  assert.match((r as { reason: string }).reason, /found: id, version/)
})

test("SQL literals and identifiers are escaped", () => {
  assert.match(historyProbeSql("a'b"), /'a''b'/)
  assert.equal(lastAppliedSql('we"ird', "migration_id"), `select "migration_id" from "we""ird" order by "migration_id" desc limit 1;`)
})
