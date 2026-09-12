import { test } from "node:test"
import assert from "node:assert/strict"
import { scanDestructive, parseSquawk } from "../.dagger/src/core/sql-scan.ts"

// The EF rename trap: this is exactly what EF emits when a property is renamed.
const RENAME_AS_DROP_ADD = `
ALTER TABLE orders DROP COLUMN "CreatedAt";
ALTER TABLE orders ADD "CreatedOn" timestamp with time zone NOT NULL DEFAULT now();
`

const PROPER_RENAME = `
ALTER TABLE orders RENAME COLUMN "CreatedAt" TO "CreatedOn";
`

test("catches the EF rename trap (DROP + ADD)", () => {
  const f = scanDestructive(RENAME_AS_DROP_ADD)
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, "drop-column")
  assert.equal(f[0].line, 2)
})

test("a proper RENAME COLUMN passes", () => {
  assert.deepEqual(scanDestructive(PROPER_RENAME), [])
})

test("an intent marker anywhere in the script suppresses the gate (D6)", () => {
  const sql = `-- shipkit:destructive-ok column was never populated in production\n${RENAME_AS_DROP_ADD}`
  assert.deepEqual(scanDestructive(sql), [])
})

test("a marker inside a string literal does not suppress the gate", () => {
  const sql = `INSERT INTO notes (body) VALUES ('-- shipkit:destructive-ok nice try');\nALTER TABLE orders DROP COLUMN "CreatedAt";`
  const f = scanDestructive(sql)
  assert.equal(f.length, 1, "the literal must not be read as a marker")
  assert.equal(f[0].rule, "drop-column")
})

test("catches DROP TABLE and ALTER COLUMN ... TYPE", () => {
  const f = scanDestructive(`DROP TABLE legacy_orders;\nALTER TABLE orders ALTER COLUMN total TYPE numeric(18,2);`)
  assert.deepEqual(f.map((x) => x.rule), ["drop-table", "alter-column-type"])
})

test("an ordinary additive migration passes", () => {
  const f = scanDestructive(`
    ALTER TABLE orders ADD "Note" text NULL;
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_created_at ON orders (created_at);
  `)
  assert.deepEqual(f, [])
})

test("unparseable Squawk output is a finding, never a pass", () => {
  const f = parseSquawk("panic: something went wrong")
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, "squawk-output-unparseable")
})

test("empty Squawk output is a pass", () => {
  assert.deepEqual(parseSquawk("   "), [])
})

test("parses Squawk findings", () => {
  const f = parseSquawk(JSON.stringify([
    { rule_name: "require-concurrent-index-creation", file: "migration.sql", line: 14, message: "use CONCURRENTLY" },
  ]))
  assert.equal(f[0].rule, "require-concurrent-index-creation")
  assert.equal(f[0].line, 14)
})
