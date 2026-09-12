import { test } from "node:test"
import assert from "node:assert/strict"
import {
  findLosses,
  parseSnapshot,
  unacknowledgedLosses,
  staleAllowances,
} from "../.dagger/src/core/schema-snapshot.ts"

const snap = (columns: string[], rows: Record<string, number>) => ({ columns, rows })

const BEFORE = snap(
  ["orders.Id", "orders.Reference", "orders.Total", "orders.CreatedAt",
   "__EFMigrationsHistory.MigrationId", "__EFMigrationsHistory.ProductVersion"],
  { orders: 3, __EFMigrationsHistory: 1 },
)

test("an additive migration loses nothing", () => {
  const after = snap([...BEFORE.columns, "orders.Note"], { orders: 3, __EFMigrationsHistory: 2 })
  assert.deepEqual(findLosses(BEFORE, after), [])
})

test("the rename trap is caught: DROP + ADD loses the column and keeps the rows", () => {
  // This is exactly what EF emits for a renamed property. Row count is unchanged, which is
  // why a row-count check alone would miss it.
  const after = snap(
    ["orders.Id", "orders.Reference", "orders.Total", "orders.CreatedOn",
     "__EFMigrationsHistory.MigrationId", "__EFMigrationsHistory.ProductVersion"],
    { orders: 3, __EFMigrationsHistory: 2 },
  )
  const losses = findLosses(BEFORE, after)
  assert.equal(losses.length, 1)
  assert.match(losses[0].message, /orders\.CreatedAt/)
  assert.match(losses[0].message, /3 row\(s\)/)
})

test("a proper RENAME COLUMN is indistinguishable from the trap and is also caught", () => {
  // Honest limitation, recorded as a test: at the schema level a correct rename looks the
  // same as a destructive one. The gate reports it; expand/contract is the intended answer,
  // and docs/adr/0005 says a rename must be split across releases anyway.
  const after = snap(
    ["orders.Id", "orders.Reference", "orders.Total", "orders.CreatedOn",
     "__EFMigrationsHistory.MigrationId", "__EFMigrationsHistory.ProductVersion"],
    { orders: 3, __EFMigrationsHistory: 2 },
  )
  assert.equal(findLosses(BEFORE, after).length, 1)
})

test("a dropped table is reported once, not once per column", () => {
  const after = snap(
    ["__EFMigrationsHistory.MigrationId", "__EFMigrationsHistory.ProductVersion"],
    { __EFMigrationsHistory: 2 },
  )
  const losses = findLosses(BEFORE, after)
  assert.equal(losses.length, 1)
  assert.match(losses[0].message, /table "orders" no longer exists/)
  assert.match(losses[0].message, /3 row\(s\)/)
})

test("deleted rows are caught even when the schema is untouched", () => {
  const after = snap(BEFORE.columns, { orders: 1, __EFMigrationsHistory: 2 })
  const losses = findLosses(BEFORE, after)
  assert.equal(losses.length, 1)
  assert.match(losses[0].message, /lost rows: 3 before, 1 after/)
})

test("the migrations history table is ignored — it gains a row by design", () => {
  const after = snap(BEFORE.columns, { orders: 3, __EFMigrationsHistory: 9 })
  assert.deepEqual(findLosses(BEFORE, after), [])
})

test("dropping the history table itself is not reported", () => {
  const after = snap(["orders.Id", "orders.Reference", "orders.Total", "orders.CreatedAt"],
    { orders: 3 })
  assert.deepEqual(findLosses(BEFORE, after), [])
})

test("new tables and rows are not losses", () => {
  const after = snap([...BEFORE.columns, "customers.Id"],
    { orders: 5, customers: 2, __EFMigrationsHistory: 2 })
  assert.deepEqual(findLosses(BEFORE, after), [])
})

test("parses the snapshot query's JSON output", () => {
  const raw = `{"columns":["orders.Id","orders.Total"],"rows":{"orders":3}}`
  assert.deepEqual(parseSnapshot(raw), {
    columns: ["orders.Id", "orders.Total"],
    rows: { orders: 3 },
  })
})

test("an empty database parses to empty, not to a crash", () => {
  assert.deepEqual(parseSnapshot(`{"columns":[],"rows":{}}`), { columns: [], rows: {} })
})

test("an acknowledged column loss is filtered out", () => {
  const after = snap(
    ["orders.Id", "orders.Reference", "orders.Total", "orders.CreatedOn",
     "__EFMigrationsHistory.MigrationId", "__EFMigrationsHistory.ProductVersion"],
    { orders: 3, __EFMigrationsHistory: 2 },
  )
  const losses = findLosses(BEFORE, after)
  assert.deepEqual(unacknowledgedLosses(losses, ["orders.CreatedAt"]), [])
})

test("acknowledging a table acknowledges its columns", () => {
  const after = snap(["__EFMigrationsHistory.MigrationId"], { __EFMigrationsHistory: 2 })
  const losses = findLosses(BEFORE, after)
  assert.deepEqual(unacknowledgedLosses(losses, ["orders"]), [])
})

test("acknowledging one column does not acknowledge a similarly named one", () => {
  // Substring matching would let "orders.CreatedAt" waive "orders.CreatedAtUtc".
  const before = snap(["orders.CreatedAt", "orders.CreatedAtUtc"], { orders: 2 })
  const after = snap([], { orders: 2 })
  const remaining = unacknowledgedLosses(findLosses(before, after), ["orders.CreatedAt"])
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].target, "orders.CreatedAtUtc")
})

test("a marker that waives nothing is reported as stale", () => {
  const after = snap([...BEFORE.columns, "orders.Note"], { orders: 3, __EFMigrationsHistory: 2 })
  const losses = findLosses(BEFORE, after)
  assert.deepEqual(staleAllowances(losses, ["orders.CreatedAt"]), ["orders.CreatedAt"])
})

test("a marker that matches a real loss is not stale", () => {
  const after = snap(
    ["orders.Id", "orders.Reference", "orders.Total",
     "__EFMigrationsHistory.MigrationId", "__EFMigrationsHistory.ProductVersion"],
    { orders: 3, __EFMigrationsHistory: 2 },
  )
  const losses = findLosses(BEFORE, after)
  assert.deepEqual(staleAllowances(losses, ["orders.CreatedAt"]), [])
})
