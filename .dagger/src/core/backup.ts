import { dag, File, Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { backupUnverified } from "./gates.js"
import { infraError } from "../errors.js"
import { PG_IMAGE, PG_PASSWORD, PG_USER, postgresService } from "./postgres.js"
import { remoteScript, shq, sshContainer } from "./ssh.js"
import { copyDumpCommand } from "./ssh-command.js"
import {
  TABLE_COUNT,
  backupDir,
  backupFileName,
  describeNewest,
  listingScript,
  parseCount,
  parseListing,
  parseSha256,
  restoreArgs,
  restoreShortfall,
  retentionVictims,
  storeScript,
  tableCountScript,
} from "./backup-store.js"

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
      /** Tables production had when asked, just before the dump. */
      productionTables: number
      /** Where the verified dump is kept on the server — the file a restore starts from. */
      path: string
      /** Of the stored file, as the server computed it after the upload. */
      sha256: string
      /** Older dumps deleted to stay within `backupRetention`. */
      pruned: string[]
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

/** Where a verified dump is stored, and how many of them to keep. */
export interface BackupStore {
  /** Kamal's service name; the dumps live in /var/backups/shipkit/<service>. */
  service: string
  /** The commit being deployed, which names the file. */
  sha: string
  retention: number
}

/**
 * Dumps production, proves the dump can be restored (decision D7), and stores it on the server.
 *
 * "Non-empty" is not the property that matters. A dump can be the right size, parse as an
 * archive, and still restore into nothing — or into three of forty tables. The only evidence
 * worth having is a restore that finished without an error and produced every table production
 * has, so that is what this gate requires.
 *
 * And a verified dump nobody kept is not a backup. It used to be proven restorable and then
 * discarded with the container that held it (B1): the gate passed, the migration ran, and there
 * was nothing to restore from. The dump is now stored before this returns, and failing to store
 * it fails the gate — the migration never runs against a production nobody can put back.
 */
export async function backup(
  env: Environment,
  key: Secret,
  store: BackupStore,
  outPath = "/out/dump.pgc",
): Promise<{ result: BackupResult; dump?: File }> {
  if (!env.dbContainer) {
    throw backupUnverified("no database container is configured for this environment")
  }
  // Checked before dumping: finding out after a ten-minute dump that there is nowhere to put it
  // wastes the ten minutes.
  const dir = backupDir(store.service)
  if (!dir) {
    throw backupUnverified(
      `the service name "${store.service}" cannot name a backup directory; set "service" in shipkit.yaml`,
    )
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
    `${remoteScript(env, `docker exec ${shq(env.dbContainer)} pg_dump -Fc -U ${shq(env.dbUser)} ${shq(env.database)}`)} > ${shq(outPath)}`,
  ])

  const dump = dumped.file(outPath)
  const bytes = Number(await dump.size())
  if (bytes < MIN_BYTES) {
    throw backupUnverified(`the dump is ${bytes} bytes, which cannot be a real archive`)
  }

  // Both the count and what pg_restore actually said: a gate that reports only "could not
  // read it" costs a round trip every time it fires, and this one fires on real problems.
  // Whether the file starts like an archive is said in words, never shown: the message ends up
  // in the run report, and the dump's bytes are production data.
  const listing = await dumped
    .withExec([
      "sh",
      "-c",
      `pg_restore --list ${shq(outPath)} 2>&1 | head -40; echo "---"; ` +
        `if [ "$(head -c 5 ${shq(outPath)})" = PGDMP ]; then echo "starts with the custom-format signature"; ` +
        `else echo "does not start with the custom-format signature"; fi`,
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
    // Any error fails the restore, and a failed restore fails the gate (B3).
    .withExec(restoreArgs("scratch", PG_USER, "restore_check", "/dump.pgc"))
    .withExec([
      "psql", "-v", "ON_ERROR_STOP=1",
      `postgresql://${PG_USER}:${PG_PASSWORD}@scratch:5432/restore_check`,
      "-tAc",
      TABLE_COUNT,
    ])
    .stdout()

  const restoredTables = parseCount(restored)
  if (restoredTables === null) {
    throw backupUnverified(`could not read the table count of the restored copy: ${restored.trim().slice(0, 300)}`)
  }
  const shortfall = restoreShortfall(restoredTables, tables)
  if (shortfall) throw backupUnverified(shortfall)

  const stored = await persist(env, key, dump, dir, store)
  return {
    result: {
      status: "verified",
      bytes,
      entries,
      restoredTables,
      productionTables: tables,
      path: stored.path,
      sha256: stored.sha256,
      pruned: stored.pruned,
    },
    dump,
  }
}

/**
 * How many tables production actually has, asked over the same channel as the dump.
 *
 * Anything but a number is an infrastructure failure, never zero. Zero means "nothing to back
 * up", so an answer misread as zero is the one mistake that switches the backup off (B11).
 */
async function productionTableCount(env: Environment, key: Secret): Promise<number> {
  const script = tableCountScript(env)

  let out: string
  try {
    out = await sshContainer(env, key)
      .withExec(["sh", "-c", remoteScript(env, script)])
      .stdout()
  } catch (err) {
    throw infraError(
      `could not ask production how many tables it has: ${(err as Error).message.slice(0, 300)}`,
      `Check that ${env.dbContainer} is running and that ${env.dbUser} can connect to ${env.database}.`,
    )
  }

  const n = parseCount(out)
  if (n === null) {
    throw infraError(
      `could not read the table count from production; psql said: ${out.trim().slice(0, 300) || "(nothing)"}`,
      "An unreadable answer is not \"production is empty\" — reading it as empty is what skips the backup.",
    )
  }
  return n
}

/**
 * Puts the verified dump in the service's backup directory on the server (storeScript: temporary
 * name, digest compared, chmod 600, atomic rename), then applies retention.
 */
async function persist(
  env: Environment,
  key: Secret,
  dump: File,
  dir: string,
  store: BackupStore,
): Promise<{ path: string; sha256: string; pruned: string[] }> {
  const name = backupFileName(store.sha, new Date())
  const path = `${dir}/${name}`
  const temp = `${dir}/.${name}.partial`
  // Built by core/ssh-command.ts rather than spelled out here: the deploy key's forced command
  // checks where an upload is going, and two spellings of the same scp is how that check starts
  // disagreeing with what is actually sent (docs/runbooks/deploy-key.md).
  const scp = copyDumpCommand(env, "/backup/dump.pgc", temp)

  // The digest is compared before the rename: a dump that arrived different from the one that
  // was restored is not the verified dump.
  const upload = storeScript({
    local: "/backup/dump.pgc",
    dir,
    temp,
    path,
    upload: scp,
    remote: (script) => remoteScript(env, script),
  })

  let sha256: string | null
  try {
    sha256 = parseSha256(
      await sshContainer(env, key)
        .withMountedFile("/backup/dump.pgc", dump)
        .withExec(["sh", "-c", upload])
        .stdout(),
    )
  } catch (err) {
    // Best effort, and never allowed to replace the reason: a failed cleanup must not be what
    // the report says went wrong.
    await sshContainer(env, key)
      .withExec(["sh", "-c", remoteScript(env, `rm -f ${temp}`)])
      .sync()
      .catch(() => undefined)
    throw backupUnverified(
      `the dump was verified but could not be stored in ${dir} on the server: ${(err as Error).message.slice(0, 400)}. ` +
        `The directory must exist and belong to ${env.sshUser} (server/bootstrap.sh creates it)`,
    )
  }
  if (!sha256) {
    throw backupUnverified(`the dump was uploaded to ${path} but its digest could not be read back`)
  }

  // Retention runs only after the new dump is in place, and never deletes it.
  const listing = parseListing(await listBackups(env, key, dir))
  if (!listing.ok) {
    throw backupUnverified(`the dump is stored at ${path}, but the backup directory could not be listed: ${listing.reason}`)
  }
  if (!listing.files.some((f) => f.name === name)) {
    throw backupUnverified(`the dump was renamed to ${path}, but the server does not list it`)
  }
  const pruned = retentionVictims(listing.files, store.retention, name)
  // A retention that silently stops working fills the disk the database lives on, so failing to
  // prune fails the stage too — with the new dump already safely in place.
  if (pruned.length > 0) {
    try {
      await sshContainer(env, key)
        .withExec(["sh", "-c", remoteScript(env, `cd ${shq(dir)} && rm -f -- ${pruned.map(shq).join(" ")}`)])
        .sync()
    } catch (err) {
      throw infraError(
        `the dump is stored at ${path}, but older backups could not be deleted: ${(err as Error).message.slice(0, 300)}`,
        `Check ownership of ${dir} on the server; retention keeps ${store.retention}.`,
      )
    }
  }
  return { path, sha256, pruned }
}

function listBackups(env: Environment, key: Secret, dir: string): Promise<string> {
  return sshContainer(env, key)
    .withExec(["sh", "-c", remoteScript(env, listingScript(dir))])
    .stdout()
}

/**
 * The newest verified dump on the server, for the plan: its name and when the server wrote it.
 * Null when the service has never stored one. A listing that cannot be read is an error, not
 * "never" — the plan must not claim there is no backup because it failed to look.
 */
export async function newestBackup(env: Environment, key: Secret, service: string): Promise<string | null> {
  const dir = backupDir(service)
  if (!dir) return null
  const listing = parseListing(await listBackups(env, key, dir))
  if (!listing.ok) {
    throw infraError(`cannot read the backups on the server: ${listing.reason}`)
  }
  return describeNewest(listing.files)
}
