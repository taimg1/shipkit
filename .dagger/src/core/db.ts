import { dag, Directory, File, ReturnType } from "@dagger.io/dagger"
import { Config } from "../config.js"
import { DbAdapter } from "../adapters/types.js"
import { Finding, withDetail } from "../report.js"
import type { Loss } from "./schema-snapshot.js"
import { ShipkitError } from "../errors.js"
import { dataLoss, destructiveSql, emptyScript, squawkFailed, staleAllowance } from "./gates.js"
import { PG_IMAGE, PG_PASSWORD, PG_USER, dsnFor, postgresService } from "./postgres.js"
import { SQUAWK_BASE_IMAGE } from "./images.js"
import {
  SNAPSHOT_SQL,
  findLosses,
  parseSnapshot,
  staleAllowances,
  unacknowledgedLosses,
} from "./schema-snapshot.js"
import {
  applyAllowances,
  hasNoSchemaChange,
  migrationForLine,
  parseAllowedLosses,
  parseSquawk,
  scanDestructive,
} from "./sql-scan.js"
/** Scratch database used for apply-to-copy. Never the same name as anything real. */
const COPY_DB = "shipkit_copy"
const SEED_DIR = "ci"
const SEED_NAME = "seed.sql"

/**
 * Squawk is installed from npm rather than pulled as an image: the published image has no
 * linux/arm64 manifest, so it fails on Apple Silicon while working on CI — the worst kind of
 * difference. The npm package ships native binaries for both architectures and npm picks the
 * right one.
 *
 * Debian, not Alpine: the prebuilt binaries are glibc.
 *
 * The version is pinned. Squawk's rule set changes between releases, and a linter that
 * silently gains or loses a rule changes what the gate means.
 */
const SQUAWK_BASE = SQUAWK_BASE_IMAGE
const SQUAWK_VERSION = "2.65.0"

/**
 * Gate 1 — lint the pending migration SQL.
 *
 * The JSON reporter flag, its output shape and the exit codes were observed on squawk-cli
 * 2.65.0 (see parseSquawk). Still UNVERIFIED: that Squawk does NOT see statements wrapped in
 * DO $$ blocks (the false-green risk, §7.2) — the M3 checkpoint in docs/v1-plan.md.
 */
export async function lintSql(sql: File, src: Directory): Promise<Finding[]> {
  const run = dag
    .container()
    .from(SQUAWK_BASE)
    .withExec(["npm", "install", "-g", `squawk-cli@${SQUAWK_VERSION}`])
    .withMountedFile("/work/migration.sql", sql)
    .withMountedFile("/work/.squawk.toml", await squawkConfig(src))
    .withExec(
      ["squawk", "--config", "/work/.squawk.toml", "--reporter", "json", "/work/migration.sql"],
      // A non-zero exit may be the finding, not an error — but it may also be Squawk failing
      // to run at all. The code and stderr are read so parseSquawk can tell the two apart.
      { expect: ReturnType.Any },
    )

  return parseSquawk(await run.stdout(), await run.exitCode(), await run.stderr())
}

/**
 * The client repo's own `.squawk.toml` when it has one, otherwise the kit's default.
 *
 * The default is deliberately a file in the module rather than a string in the code: it is
 * meant to be read and argued with, and `shipkit init` hands the same file to client repos.
 * Two copies of a rule set would drift within a release.
 */
async function squawkConfig(src: Directory): Promise<File> {
  const names = await src.entries()
  if (names.includes(".squawk.toml")) return src.file(".squawk.toml")
  return dag.currentModule().source().file("squawk.default.toml")
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
  // The base is on the entry whether the stage passes or fails. Without it a run with no base
  // lints the entire history and reads exactly like a run with a base and bad migrations (#5).
  const base = from ?? "none"
  const pending = await db.pendingList(src, cfg, from)

  try {
    return await gateMigrations(src, cfg, db, from, pending, base)
  } catch (err) {
    if (err instanceof ShipkitError) {
      err.detail = { ...err.detail, base, pending }
      if (!from) {
        err.next =
          `No migration base: all ${pending.length} migration(s) in the project were checked, ` +
          `not only new ones. The base is the newest migration on origin/${cfg.defaultBranch}; ` +
          `push that branch, or pass --migration-base=<id> for the migration production already has. ` +
          (err.next ?? "")
      }
    }
    throw err
  }
}

async function gateMigrations(
  src: Directory,
  cfg: Config,
  db: DbAdapter,
  from: string | null,
  pending: string[],
  base: string,
) {
  if (pending.length === 0) {
    return withDetail<DbStageResult>({ pending: [], findings: [] }, { base, pending: [], note: "no pending migrations" })
  }

  const sqlFile = db.sqlBetween(src, cfg, from, null)
  const sqlText = await sqlFile.contents()

  // Before linting anything: the list says there is work, so the script must contain work.
  // If it does not, the assembly is stale and every gate below would inspect an empty file.
  if (hasNoSchemaChange(sqlText)) throw emptyScript(pending)

  // Parsed once and applied to every destructive gate, so the marker means the same thing
  // wherever it is read.
  const allowed = parseAllowedLosses(sqlText)

  // Findings name the migration they came from, not only a line in the combined script.
  const located = (fs: Finding[]) =>
    fs.map((f) => (f.line ? { ...f, migration: migrationForLine(sqlText, f.line, db.historyTable) } : f))

  const findings = located(applyAllowances(await lintSql(sqlFile, src), sqlText, allowed))
  if (findings.length > 0) throw squawkFailed(findings)

  const destructive = located(scanDestructive(sqlText))
  if (destructive.length > 0) throw destructiveSql(destructive)

  // The strongest mitigation for the rename trap: apply the migration to a copy that has
  // rows in it and see what survived. Squawk and the grep scan read intent out of SQL;
  // this reads consequences out of a database.
  const losses = await applyToCopy(src, cfg, db, from)
  const unacknowledged = unacknowledgedLosses(losses, allowed)
  if (unacknowledged.length > 0) throw dataLoss(unacknowledged.map((l) => l.message).join("; "))

  const stale = staleAllowances(losses, allowed)
  if (stale.length > 0) throw staleAllowance(stale)

  return withDetail<DbStageResult>(
    { pending, findings: [] },
    {
      base,
      pending,
      checked: from
        ? `${pending.length} migration(s) applied to a copy of ${from}`
        : `${pending.length} migration(s) applied to an empty database ` +
          `(no deployed baseline, so nothing to seed and nothing to lose)`,
      // Acknowledged losses are still reported. A waiver should be visible in the run that
      // used it, not only in the migration that declared it.
      acknowledgedLosses: losses.map((l) => l.message),
    },
  )
}

/**
 * Rebuilds production's schema on a scratch database, seeds it, applies the pending
 * migrations, and reports anything that stopped existing.
 *
 * Everything runs in one container so the ordering is guaranteed and the Postgres service is
 * a single instance throughout — snapshots taken against different instances would compare
 * nothing.
 */
export async function applyToCopy(
  src: Directory,
  cfg: Config,
  db: DbAdapter,
  from: string | null,
): Promise<Loss[]> {
  const baseline = db.sqlBetween(src, cfg, null, from)
  const pending = db.sqlBetween(src, cfg, from, null)

  // The seed describes rows that exist in production, so it only makes sense on top of the
  // schema production has. With nothing deployed there is no baseline, the scratch database
  // is empty, and running the seed would fail on tables the pending migration has not created
  // yet. There is also nothing to protect: no prior state means no loss is possible.
  const seed = from ? await seedFile(src) : null

  const service = postgresService(COPY_DB)
  const dsn = dsnFor("db", COPY_DB)

  let c = dag
    .container()
    .from(PG_IMAGE)
    .withServiceBinding("db", service)
    .withEnvVariable("PGPASSWORD", PG_PASSWORD)
    .withMountedFile("/sql/baseline.sql", baseline)
    .withMountedFile("/sql/pending.sql", pending)
    .withMountedFile("/sql/snapshot.sql", snapshotFile())
    .withExec(["sh", "-c", `mkdir -p /out; until pg_isready -h db -U ${PG_USER} >/dev/null 2>&1; do sleep 1; done`])

  // With nothing deployed there is no prior state to protect, and the baseline script is
  // empty; applying it would be a no-op with a confusing failure mode.
  if (from) {
    c = c.withExec(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-q", "-f", "/sql/baseline.sql"])
  }
  if (seed) {
    c = c
      .withMountedFile("/sql/seed.sql", seed)
      .withExec(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-q", "-f", "/sql/seed.sql"])
  }

  c = c
    .withExec(["sh", "-c", `psql "${dsn}" -tA -f /sql/snapshot.sql > /out/before.json`])
    .withExec(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-q", "-f", "/sql/pending.sql"])
    .withExec(["sh", "-c", `psql "${dsn}" -tA -f /sql/snapshot.sql > /out/after.json`])

  const before = parseSnapshot(await c.file("/out/before.json").contents())
  const after = parseSnapshot(await c.file("/out/after.json").contents())

  return findLosses(before, after)
}

/** The seed is optional; without it apply-to-copy still checks the schema, just not rows. */
async function seedFile(src: Directory): Promise<File | null> {
  try {
    const names = await src.directory(SEED_DIR).entries()
    return names.includes(SEED_NAME) ? src.file(`${SEED_DIR}/${SEED_NAME}`) : null
  } catch {
    return null
  }
}

function snapshotFile(): File {
  return dag.directory().withNewFile("snapshot.sql", SNAPSHOT_SQL).file("snapshot.sql")
}
