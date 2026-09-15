import { dag, File, Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { backupUnverified } from "./gates.js"
import { PG_IMAGE, PG_PASSWORD, PG_USER, postgresService } from "./postgres.js"
import { remoteScript, sshContainer } from "./ssh.js"

/**
 * Gate 2 evidence. A backup is what was proven restorable, not what was written.
 *
 * "Production has no schema yet" is a distinct outcome, not a degraded one. On a first
 * deploy there is nothing to dump and nothing to lose, and refusing to proceed because an
 * empty database produced an empty dump would block exactly the deploy that is safest.
 */
export type BackupResult =
  | {
      status: "verified"
      bytes: number
      /** Entries in the dump's table of contents, from `pg_restore --list`. */
      entries: number
      /** Tables present after actually restoring it into an empty database. */
      restoredTables: number
      /** Where the verified dump can be read from. */
      path: string
    }
  | {
      status: "empty-database"
      reason: string
    }

/**
 * An empty-but-valid custom-format dump of a schemaless database is about 800 bytes.
 * A size threshold alone therefore proves almost nothing — it is here only to catch the
 * truncated-to-nothing case early, before spending time on a restore.
 */
const MIN_BYTES = 100

/**
 * Dumps production, then proves the dump can be restored (decision D7).
 *
 * "Non-empty" is not the property that matters. A dump can be the right size, parse as an
 * archive, and still restore into nothing. The only evidence worth having is a restore that
 * produced tables, so that is what this gate requires.
 */
export async function backup(
  env: Environment,
  key: Secret,
  outPath = "/out/dump.pgc",
): Promise<{ result: BackupResult; dump?: File }> {
  if (!env.dbContainer) {
    throw backupUnverified("no database container is configured for this environment")
  }

  // Asked before dumping, so that an empty dump can be told apart from a broken one. These
  // look identical in the archive and mean opposite things.
  const tables = await productionTableCount(env, key)
  if (tables === 0) {
    return {
      result: {
        status: "empty-database",
        reason: "production has no tables yet, so there is nothing to back up and nothing to lose",
      },
    }
  }

  const base = sshContainer(env, key)

  // pg_dump writes to stdout on the server and the bytes are redirected here; nothing is
  // left behind on a machine that may be about to have its schema changed.
  const dumped = base.withExec([
    "sh",
    "-c",
    `${remoteScript(env, `docker exec ${env.dbContainer} pg_dump -Fc -U ${env.dbUser} ${env.database}`)} > ${outPath}`,
  ])

  const dump = dumped.file(outPath)
  const bytes = Number(await dump.size())
  if (bytes < MIN_BYTES) {
    throw backupUnverified(`the dump is ${bytes} bytes, which cannot be a real archive`)
  }

  // Both the count and what pg_restore actually said: a gate that reports only "could not
  // read it" costs a round trip every time it fires, and this one fires on real problems.
  const listing = await dumped
    .withExec([
      "sh",
      "-c",
      `pg_restore --list ${outPath} 2>&1 | head -40; echo "---"; head -c 200 ${outPath} | od -c | head -5`,
    ])
    .stdout()

  const entries = listing
    .split("\n")
    .filter((l) => /^\d+;/.test(l.trim())).length

  if (entries <= 0) {
    throw backupUnverified(
      `pg_restore read no table of contents. What it saw:\n${listing.slice(0, 800)}`,
    )
  }

  // The actual proof: restore it somewhere and look.
  const scratch = postgresService("restore_check")
  const restored = await dag
    .container()
    .from(PG_IMAGE)
    .withServiceBinding("scratch", scratch)
    .withMountedFile("/dump.pgc", dump)
    .withEnvVariable("PGPASSWORD", PG_PASSWORD)
    .withExec([
      "sh",
      "-c",
      `until pg_isready -h scratch -U ${PG_USER} >/dev/null 2>&1; do sleep 1; done`,
    ])
    // pg_restore exits non-zero on benign ownership warnings; the table count is the verdict.
    .withExec([
      "sh",
      "-c",
      `pg_restore -h scratch -U ${PG_USER} -d restore_check --no-owner --no-privileges /dump.pgc || true`,
    ])
    .withExec([
      "psql",
      `postgresql://${PG_USER}:${PG_PASSWORD}@scratch:5432/restore_check`,
      "-tAc",
      "select count(*) from information_schema.tables where table_schema='public'",
    ])
    .stdout()

  const restoredTables = Number(restored.trim())
  if (!Number.isFinite(restoredTables) || restoredTables <= 0) {
    throw backupUnverified(
      "the dump restored into an empty database — it parses, but it contains nothing",
    )
  }

  return { result: { status: "verified", bytes, entries, restoredTables, path: outPath }, dump }
}

/** How many tables production actually has, asked over the same channel as the dump. */
async function productionTableCount(env: Environment, key: Secret): Promise<number> {
  const query =
    "select count(*) from information_schema.tables where table_schema='public'"
  // stdin and a quoted heredoc, for the same reason as in history.ts: nothing in the query
  // then has to survive a shell.
  const script =
    `docker exec -i ${env.dbContainer} psql -U ${env.dbUser} -d ${env.database} -tA ` +
    `<<'SHIPKIT_SQL'\n${query}\nSHIPKIT_SQL\n`

  const out = await sshContainer(env, key)
    .withExec(["sh", "-c", remoteScript(env, script)])
    .stdout()

  const n = Number(out.trim())
  if (!Number.isFinite(n)) {
    // Failing closed: an unreadable answer is not "production is empty". Reading it as
    // empty is what skips the backup entirely.
    throw backupUnverified(
      `could not read the table count from production; psql said: ${out.trim().slice(0, 300)}`,
    )
  }
  return n
}
