import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, existsSync, rmSync } from "node:fs"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  backupExportDir,
  backupOut,
  collectBackup,
  commandKey,
  parseArgs,
  translate,
  validateOptions,
} from "../bin/lib.mjs"

const ctx = {
  sha: () => "abc1234def",
  branch: () => "dev",
  migrationBase: () => undefined,
  dirty: () => false,
  env: {},
}

const argsFor = (argv: string[]) => {
  const opts = parseArgs(argv)
  const key = commandKey(opts._)
  return { opts, invalid: validateOptions(key, opts), args: translate(key, opts, ctx) }
}

test("backup exports the module's directory beside --out, not the dump itself", () => {
  // The bug (D-01): `export --path=<out>` printed a path, the wrapper expected JSON, and a
  // successful backup exited 3.
  const { invalid, args } = argsFor(["backup", "--out", "drills/prod.pgc"])
  assert.equal(invalid, undefined)
  assert.equal(args[0], "backup")
  assert.deepEqual(args.slice(-2), ["export", "--path=drills/.prod.pgc.shipkit-export"])
})

test("backup names the commit, so the file on the server says which deploy it preceded", () => {
  assert.ok(argsFor(["backup"]).args.includes("--sha=abc1234def"))
})

test("backup writes prod-backup.pgc by default", () => {
  assert.equal(backupOut({}), "prod-backup.pgc")
  assert.equal(backupExportDir("prod-backup.pgc"), ".prod-backup.pgc.shipkit-export")
})

const scratch = () => mkdtempSync(join(tmpdir(), "shipkit-backup-test-"))

const report = (ok: boolean) => ({ command: "backup", ok, exitCode: ok ? 0 : 1, stages: [] })

test("a verified backup lands at --out, owner-only", () => {
  const root = scratch()
  try {
    const dir = join(root, "export")
    mkdirSync(dir)
    writeFileSync(join(dir, "report.json"), JSON.stringify(report(true)))
    writeFileSync(join(dir, "dump.pgc"), "PGDMP", { mode: 0o644 })
    const out = join(root, "prod.pgc")

    const r = collectBackup(dir, out, fs)
    assert.equal(r.error, undefined)
    assert.equal(r.report.ok, true)
    assert.equal(r.report.written, out)
    assert.equal(readFileSync(out, "utf8"), "PGDMP")
    assert.equal(statSync(out).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an existing --out is replaced by an owner-only file, not rewritten in place", () => {
  const root = scratch()
  try {
    const dir = join(root, "export")
    mkdirSync(dir)
    writeFileSync(join(dir, "report.json"), JSON.stringify(report(true)))
    writeFileSync(join(dir, "dump.pgc"), "PGDMP-new")
    const out = join(root, "prod.pgc")
    writeFileSync(out, "old", { mode: 0o644 })

    collectBackup(dir, out, fs)
    assert.equal(readFileSync(out, "utf8"), "PGDMP-new")
    assert.equal(statSync(out).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a failed backup returns its report and writes nothing", () => {
  const root = scratch()
  try {
    const dir = join(root, "export")
    mkdirSync(dir)
    writeFileSync(join(dir, "report.json"), JSON.stringify(report(false)))
    const out = join(root, "prod.pgc")

    const r = collectBackup(dir, out, fs)
    assert.equal(r.report.ok, false)
    assert.equal(r.report.exitCode, 1)
    assert.equal(existsSync(out), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("no report means Dagger itself failed, never a success", () => {
  const root = scratch()
  try {
    const r = collectBackup(join(root, "missing"), join(root, "prod.pgc"), fs)
    assert.match(r.error, /no readable report/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a success with no dump is an error, not a green run with nothing on disk", () => {
  const root = scratch()
  try {
    const dir = join(root, "export")
    mkdirSync(dir)
    writeFileSync(join(dir, "report.json"), JSON.stringify(report(true)))
    const r = collectBackup(dir, join(root, "prod.pgc"), fs)
    assert.match(r.error, /no dump/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
