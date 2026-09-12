import { dag, Container, Directory, File } from "@dagger.io/dagger"
import { Config } from "../config.js"
import { DbAdapter } from "../adapters/types.js"
import { Finding, withDetail } from "../report.js"
import { destructiveSql, squawkFailed } from "./gates.js"
import { parseSquawk, scanDestructive } from "./sql-scan.js"
import { notImplemented } from "../errors.js"

const SQUAWK_IMAGE = "ghcr.io/sbdchd/squawk:latest"

/**
 * Gate 1 — lint the pending migration SQL.
 *
 * UNVERIFIED: Squawk's JSON reporter flag and output shape have not been observed yet.
 * The M3 checkpoint in docs/v1-plan.md exists to confirm this, and to confirm that Squawk
 * does NOT see statements wrapped in DO $$ blocks (the false-green risk, §7.2).
 */
export async function lintSql(sql: File): Promise<Finding[]> {
  const raw = await dag
    .container()
    .from(SQUAWK_IMAGE)
    .withMountedFile("/work/migration.sql", sql)
    .withExec(["squawk", "--reporter", "json", "/work/migration.sql"], {
      expect: "ANY", // a non-zero exit is the finding, not an error
    })
    .stdout()

  return parseSquawk(raw)
}

export interface DbStageResult {
  pending: string[]
  findings: Finding[]
}

/**
 * The `db` stage: generate a plain SQL diff, lint it, scan it, and apply it to a seeded
 * copy to prove no data was lost.
 */
export async function dbStage(
  src: Directory,
  cfg: Config,
  db: DbAdapter,
  from: string | null,
) {
  const pending = await db.pendingList(src, cfg, from)
  if (pending.length === 0) {
    return withDetail<DbStageResult>({ pending: [], findings: [] }, { pending: [], note: "no pending migrations" })
  }

  const sqlFile = db.pendingSql(src, cfg, from)
  const sqlText = await sqlFile.contents()

  const findings = await lintSql(sqlFile)
  if (findings.length > 0) throw squawkFailed(findings)

  const destructive = scanDestructive(sqlText)
  if (destructive.length > 0) throw destructiveSql(destructive)

  // The seeded apply-to-copy check is the strongest mitigation for the rename trap and is
  // written against information_schema, so it is stack-agnostic. M3.
  throw notImplemented("apply-to-copy with seeded row/column assertions", "M3")
}

export function applyToCopy(_src: Directory, _cfg: Config, _db: DbAdapter): Container {
  throw notImplemented("apply-to-copy", "M3")
}
