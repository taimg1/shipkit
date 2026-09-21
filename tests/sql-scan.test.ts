import { test } from "node:test"
import assert from "node:assert/strict"
import {
  scanDestructive,
  parseSquawk,
  hasNoSchemaChange,
  parseAllowedLosses,
  applyAllowances,
  migrationForLine,
  statementTargets,
  allowedByMarker,
  ALLOW_LOSS_EXAMPLE,
} from "../.dagger/src/core/sql-scan.ts"

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

test("an allow-loss marker naming the column waives that statement (D6)", () => {
  const sql = `-- shipkit:allow-loss orders.CreatedAt  never populated in production\n${RENAME_AS_DROP_ADD}`
  assert.deepEqual(scanDestructive(sql), [])
})

test("a marker for one column does not excuse dropping another", () => {
  // The reason the marker names a target: a waiver obtained for one change must not let a
  // second, unintended destruction ride along inside the same migration.
  const sql = `-- shipkit:allow-loss orders.CreatedAt  reviewed
ALTER TABLE orders DROP COLUMN "CreatedAt";
ALTER TABLE orders DROP COLUMN "Reference";`
  const f = scanDestructive(sql)
  assert.equal(f.length, 1)
  assert.match(f[0].sql!, /Reference/)
})

test("parseAllowedLosses reads the targets and strips quotes", () => {
  const sql = `-- shipkit:allow-loss "orders"."CreatedAt"  reviewed
-- shipkit:allow-loss legacy_orders  table is unused`
  assert.deepEqual(parseAllowedLosses(sql), ["orders.CreatedAt", "legacy_orders"])
})

test("a marker inside a string literal does not suppress the gate", () => {
  const sql = `INSERT INTO notes (body) VALUES ('-- shipkit:allow-loss orders.CreatedAt nice try');\nALTER TABLE orders DROP COLUMN "CreatedAt";`
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
  const f = parseSquawk("panic: something went wrong", 1)
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, "squawk-output-unparseable")
})

test("a clean file is exit 0 with an empty array, and that is a pass", () => {
  // Observed on squawk-cli 2.65.0: a clean file prints `[]`, it does not print nothing.
  assert.deepEqual(parseSquawk("[]\n", 0), [])
})

test("empty Squawk output is never a pass, whatever the exit code", () => {
  // A missing file or a broken .squawk.toml: exit 1, nothing on stdout, the reason on stderr.
  // This used to read as "0 violations".
  for (const code of [0, 1]) {
    const f = parseSquawk("   ", code, "Configuration error: unexpected eof encountered at line 2 column 1")
    assert.equal(f.length, 1)
    assert.equal(f[0].rule, "squawk-did-not-run")
    assert.match(f[0].message!, /Configuration error/)
    assert.match(f[0].message!, new RegExp(`exit ${code}`))
  }
})

test("an unexpected exit code fails even with a clean-looking report", () => {
  // Exit 2 is a CLI usage error (an unknown --reporter value, a renamed flag).
  const f = parseSquawk("[]", 2, "error: invalid value 'jsonx' for '--reporter <REPORTER>'")
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, "squawk-did-not-run")
})

test("a crashed Squawk (signal, OOM) is not a pass", () => {
  assert.equal(parseSquawk("", 137)[0].rule, "squawk-did-not-run")
})

test("garbage and wrong-shaped JSON are findings, not passes", () => {
  assert.equal(parseSquawk("{not json", 1)[0].rule, "squawk-output-unparseable")
  // Valid JSON that is not the reporter's array of violations.
  assert.equal(parseSquawk('{"error":"boom"}', 1)[0].rule, "squawk-output-unparseable")
  assert.equal(parseSquawk('[{"message":"no rule name"}]', 1)[0].rule, "squawk-output-unparseable")
  assert.equal(parseSquawk('"ok"', 0)[0].rule, "squawk-output-unparseable")
})

test("exit 1 with no violations listed is a failure, not a pass", () => {
  const f = parseSquawk("[]", 1)
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, "squawk-did-not-run")
})

test("violations reported with exit 0 are still findings", () => {
  const f = parseSquawk(JSON.stringify([{ rule_name: "ban-drop-column", line: 0 }]), 0)
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, "ban-drop-column")
})

test("parses Squawk findings and converts its zero-based line", () => {
  // Verified against squawk-cli 2.65.0: `line` is zero-based, so a finding on the first
  // line of the file arrives as 0. Reporting it unchanged points the reader one line early.
  const f = parseSquawk(JSON.stringify([
    {
      rule_name: "require-concurrent-index-creation",
      file: "migration.sql",
      line: 13,
      message: "Concurrent index creation is preferred",
      help: "Use CREATE INDEX CONCURRENTLY",
    },
  ]), 1)
  assert.equal(f[0].rule, "require-concurrent-index-creation")
  assert.equal(f[0].line, 14, "zero-based 13 is line 14")
  assert.match(f[0].message!, /Concurrent index creation is preferred — Use CREATE INDEX CONCURRENTLY/)
})

test("a finding on the very first line is reported as line 1, not line 0", () => {
  const f = parseSquawk(JSON.stringify([{ rule_name: "ban-drop-column", line: 0 }]), 1)
  assert.equal(f[0].line, 1)
})

test("real squawk-cli 2.65.0 output for a DROP COLUMN parses", () => {
  const raw = `[{"file":"bad.sql","line":0,"column":14,"level":"Warning","message":"Dropping a column may break existing clients.","help":null,"rule_name":"ban-drop-column","column_end":27,"line_end":0}]`
  const f = parseSquawk(raw, 1)
  assert.deepEqual(f.map((x) => [x.rule, x.line]), [["ban-drop-column", 1]])
})

// --- Real output captured from fixtures/dotnet-api on 2026-09-12 -------------------------

/** `dotnet ef migrations script 0` with one migration compiled in. */
const REAL_INITIAL_SCRIPT = `﻿CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory" (
    "MigrationId" character varying(150) NOT NULL,
    "ProductVersion" character varying(32) NOT NULL,
    CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY ("MigrationId")
);

START TRANSACTION;
CREATE TABLE orders (
    "Id" integer GENERATED BY DEFAULT AS IDENTITY,
    "Reference" character varying(64) NOT NULL,
    "Total" numeric(18,2) NOT NULL,
    "CreatedAt" timestamp with time zone NOT NULL,
    CONSTRAINT "PK_orders" PRIMARY KEY ("Id")
);

INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion")
VALUES ('20260912083112_InitialCreate', '10.0.12');

COMMIT;
`

/**
 * What EF actually writes when nothing is pending — or when the assembly is stale and it
 * cannot see the new migration. Three bytes: a UTF-8 BOM. The two cases are indistinguishable
 * from the file alone, which is why the pending list is cross-checked against it.
 */
const REAL_EMPTY_SCRIPT = "﻿"

test("a real EF script is recognised as containing schema changes", () => {
  assert.equal(hasNoSchemaChange(REAL_INITIAL_SCRIPT), false)
})

test("EF's BOM-only output is recognised as empty", () => {
  assert.equal(hasNoSchemaChange(REAL_EMPTY_SCRIPT), true)
})

test("a script with only EF history bookkeeping is empty", () => {
  // The stale-assembly case: EF emits the history table but no migration of its own.
  const historyOnly = `﻿CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory" (
    "MigrationId" character varying(150) NOT NULL,
    "ProductVersion" character varying(32) NOT NULL,
    CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY ("MigrationId")
);
`
  assert.equal(hasNoSchemaChange(historyOnly), true)
})

test("a commented-out DDL statement does not count as a schema change", () => {
  assert.equal(hasNoSchemaChange(`-- CREATE TABLE orders (id int);`), true)
})

test("the BOM does not hide a destructive statement on the first line", () => {
  const f = scanDestructive(`﻿ALTER TABLE orders DROP COLUMN "CreatedAt";`)
  assert.equal(f.length, 1)
  assert.equal(f[0].rule, "drop-column")
})

test("the real initial migration is not destructive", () => {
  assert.deepEqual(scanDestructive(REAL_INITIAL_SCRIPT), [])
})

test("an allow-loss marker waives the matching Squawk finding", () => {
  const sql = `-- shipkit:allow-loss orders.CreatedAt  reviewed
ALTER TABLE orders DROP COLUMN "CreatedAt";`
  const findings = [{ rule: "ban-drop-column", line: 2 }]
  assert.deepEqual(applyAllowances(findings, sql, ["orders.CreatedAt"]), [])
})

test("a marker does not waive a Squawk finding on a different line", () => {
  const sql = `-- shipkit:allow-loss orders.CreatedAt  reviewed
ALTER TABLE orders DROP COLUMN "CreatedAt";
ALTER TABLE orders DROP COLUMN "Reference";`
  const findings = [
    { rule: "ban-drop-column", line: 2 },
    { rule: "ban-drop-column", line: 3 },
  ]
  const left = applyAllowances(findings, sql, ["orders.CreatedAt"])
  assert.equal(left.length, 1)
  assert.equal(left[0].line, 3)
})

test("a marker never waives a non-destructive rule", () => {
  const sql = `-- shipkit:allow-loss orders.CreatedAt  reviewed
CREATE INDEX ix ON orders ("CreatedAt");`
  const findings = [{ rule: "require-concurrent-index-creation", line: 2 }]
  assert.equal(applyAllowances(findings, sql, ["orders.CreatedAt"]).length, 1)
})

// --- which migration a script line belongs to (#5) ---

// The shape `dotnet ef migrations script` emits, taken from a real project that uses
// EFCore.NamingConventions (snake_case history columns).
const COMBINED = `START TRANSACTION;
ALTER TABLE bookings ADD passenger_count integer;

INSERT INTO "__EFMigrationsHistory" (migration_id, product_version)
VALUES ('20260906123517_OptionalPassengerCount', '10.0.1');

COMMIT;

START TRANSACTION;
ALTER TABLE routes RENAME COLUMN origin TO origin_place_key;
ALTER TABLE routes DROP COLUMN legacy_code;

INSERT INTO "__EFMigrationsHistory" (migration_id, product_version)
VALUES ('20260906204842_RenameRouteEndpoints', '10.0.1');

COMMIT;
`

test("a finding is attributed to the migration whose block contains it", () => {
  assert.equal(migrationForLine(COMBINED, 2, "__EFMigrationsHistory"), "20260906123517_OptionalPassengerCount")
  assert.equal(migrationForLine(COMBINED, 10, "__EFMigrationsHistory"), "20260906204842_RenameRouteEndpoints")
  assert.equal(migrationForLine(COMBINED, 11, "__EFMigrationsHistory"), "20260906204842_RenameRouteEndpoints")
})

test("the default EF column names work the same", () => {
  const sql = `ALTER TABLE "Orders" DROP COLUMN "Legacy";\nINSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion")\nVALUES ('20260912083112_InitialCreate', '10.0.0');`
  assert.equal(migrationForLine(sql, 1, "__EFMigrationsHistory"), "20260912083112_InitialCreate")
})

test("a trailing COMMIT after the last record belongs to the last migration", () => {
  assert.equal(migrationForLine(COMBINED, 16, "__EFMigrationsHistory"), "20260906204842_RenameRouteEndpoints")
})

test("a leading BOM does not shift the attribution", () => {
  assert.equal(migrationForLine("\uFEFF" + COMBINED, 2, "__EFMigrationsHistory"), "20260906123517_OptionalPassengerCount")
})

test("a script that records no migration attributes nothing", () => {
  assert.equal(migrationForLine("DROP TABLE x;", 1, "__EFMigrationsHistory"), undefined)
})

// --- allow-loss matches exactly what a statement touches (B9) ---

test("a column marker does not waive a different column whose name contains it", () => {
  // `orders.Id` used to waive anything whose line contained "Id".
  const sql = `-- shipkit:allow-loss orders.Id  reviewed
ALTER TABLE "invoices" DROP COLUMN "CustomerId";`
  const f = scanDestructive(sql)
  assert.equal(f.length, 1)
  assert.equal(applyAllowances([{ rule: "ban-drop-column", line: 2 }], sql, ["orders.Id"]).length, 1)
})

test("a column marker does not waive the same column name in another table", () => {
  const sql = `-- shipkit:allow-loss orders.CreatedAt  reviewed
ALTER TABLE invoices DROP COLUMN "CreatedAt";`
  assert.equal(scanDestructive(sql).length, 1)
})

test("a column marker does not waive a column that merely starts with its name", () => {
  const sql = `-- shipkit:allow-loss orders.CreatedAt  reviewed
ALTER TABLE orders DROP COLUMN "CreatedAtUtc";`
  assert.equal(scanDestructive(sql).length, 1)
})

test("a table marker waives dropping that table and its columns, and nothing else", () => {
  const sql = `-- shipkit:allow-loss legacy_orders  table is unused
DROP TABLE legacy_orders;
ALTER TABLE legacy_orders DROP COLUMN "Note";
DROP TABLE legacy_orders_archive;`
  const f = scanDestructive(sql)
  assert.deepEqual(f.map((x) => x.line), [4])
})

test("a statement touching two things is waived only when both are named", () => {
  const sql = `-- shipkit:allow-loss orders.A  reviewed
ALTER TABLE orders DROP COLUMN "A", DROP COLUMN "B";`
  assert.equal(scanDestructive(sql).length, 1)
  const both = `-- shipkit:allow-loss orders.A  reviewed\n-- shipkit:allow-loss orders.B  reviewed\nALTER TABLE orders DROP COLUMN "A", DROP COLUMN "B";`
  assert.deepEqual(scanDestructive(both), [])
})

test("identifiers are compared as PostgreSQL reads them", () => {
  // Bare identifiers fold to lower case; quoted ones keep their case; a schema is not part
  // of the target, as in the apply-to-copy snapshot.
  assert.deepEqual(statementTargets(`ALTER TABLE public."Orders" DROP COLUMN "CreatedAt";`), ["Orders.CreatedAt"])
  assert.deepEqual(statementTargets(`ALTER TABLE Orders DROP COLUMN CreatedAt;`), ["orders.createdat"])
  assert.deepEqual(statementTargets(`DROP TABLE IF EXISTS a, public.b CASCADE;`), ["a", "b"])
  assert.deepEqual(statementTargets(`ALTER TABLE orders ALTER COLUMN total TYPE numeric(18,2);`), ["orders.total"])
  assert.deepEqual(statementTargets(`ALTER TABLE orders RENAME COLUMN "A" TO "B";`), ["orders.A"])
})

test("a line that names no table is never waived", () => {
  assert.equal(statementTargets(`    "Reference" character varying(64) NOT NULL,`), null)
  assert.equal(allowedByMarker(`DROP DATABASE app;`, ["app"]), false)
})

test("the marker the destructive-sql gate suggests is the marker the scanner reads (B17)", () => {
  // gates.ts builds its advice from ALLOW_LOSS_EXAMPLE; this proves the example parses.
  const filled = ALLOW_LOSS_EXAMPLE.replace("<table>.<column>", "orders.CreatedAt").replace("<reason>", "reviewed")
  assert.deepEqual(parseAllowedLosses(filled), ["orders.CreatedAt"])
  assert.deepEqual(scanDestructive(`${filled}\nALTER TABLE orders DROP COLUMN "CreatedAt";`), [])
})
