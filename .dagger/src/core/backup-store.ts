/**
 * Where verified dumps are kept on the server, and which of them are kept — pure, so the rules
 * that decide what gets deleted can be tested without a server.
 *
 * This file must not import Dagger. A retention rule that picks the wrong file deletes the only
 * backup there was, and nothing about that would look like an error.
 */

/** Every service's backups live under here, one directory each, owned by the deploy user. */
export const BACKUP_ROOT = "/var/backups/shipkit"

/** How many verified dumps to keep per service when shipkit.yaml does not say. */
export const DEFAULT_BACKUP_RETENTION = 10

/**
 * A service name becomes a directory, and that directory gets `rm -f` run in it. Anything that
 * could climb out of BACKUP_ROOT or be read by a shell as something else is refused.
 */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** `<sha>-<UTC timestamp>.pgc` — the only names retention ever looks at. */
const BACKUP_NAME = /^([0-9A-Za-z]+)-(\d{8}T\d{6}Z)\.pgc$/

export function backupDir(service: string): string | null {
  if (!SERVICE_NAME.test(service) || service.includes("..")) return null
  return `${BACKUP_ROOT}/${service}`
}

/** 2026-09-19T12:34:56.789Z -> 20260919T123456Z. Sorts as text in the order it happened. */
export function backupStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

/**
 * `a1b2c3d-20260919T123456Z.pgc`. The commit is what was about to be deployed when the dump was
 * taken — the question during an incident is "the backup from before which deploy".
 */
export function backupFileName(sha: string, at: Date): string {
  const short = sha.replace(/[^0-9A-Za-z]/g, "").slice(0, 7) || "unknown"
  return `${short}-${backupStamp(at)}.pgc`
}

export interface StoredBackup {
  name: string
  /** Seconds since the epoch, from the server's own clock. */
  mtime: number
  bytes: number
}

const LISTING_END = "SHIPKIT_BACKUPS_END"
const NO_DIR = "SHIPKIT_BACKUPS_NONE"

/**
 * Lists the dumps in `dir` as `<mtime> <bytes> <name>`, one per line, ending with a marker.
 *
 * The marker is what tells "there are no backups" from "the answer was cut off". Without it an
 * empty reply — a dropped connection, a shell that failed early — reads as an empty directory.
 * A directory that does not exist yet is said explicitly for the same reason.
 */
export function listingScript(dir: string): string {
  return [
    `[ -d ${shq(dir)} ] || { echo ${NO_DIR}; exit 0; }`,
    `cd ${shq(dir)} || exit 3`,
    // A stat that fails stops the listing: skipping the file would list a directory of backups
    // as an empty one.
    `for f in *.pgc; do [ -f "$f" ] || continue; stat -c '%Y %s %n' "$f" || exit 3; done`,
    `echo ${LISTING_END}`,
  ].join("\n")
}

export type Listing =
  | { ok: true; exists: boolean; files: StoredBackup[] }
  | { ok: false; reason: string }

export function parseListing(out: string): Listing {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 1 && lines[0] === NO_DIR) return { ok: true, exists: false, files: [] }
  if (lines[lines.length - 1] !== LISTING_END) {
    return { ok: false, reason: `the listing did not finish: ${out.trim().slice(0, 300) || "(no output)"}` }
  }

  const files: StoredBackup[] = []
  for (const line of lines.slice(0, -1)) {
    // A name the kit did not write may contain anything; it is listed, and ignored by ownBackups.
    const m = /^(\d+) (\d+) (.+)$/.exec(line)
    if (!m) return { ok: false, reason: `unreadable line in the listing: ${line.slice(0, 200)}` }
    files.push({ mtime: Number(m[1]), bytes: Number(m[2]), name: m[3] })
  }
  return { ok: true, exists: true, files }
}

/** Only files the kit wrote, newest first by the timestamp in the name — not by mtime, which a copy or a touch changes. */
export function ownBackups(files: StoredBackup[]): StoredBackup[] {
  return files
    .filter((f) => BACKUP_NAME.test(f.name))
    .sort((a, b) => stampOf(b.name).localeCompare(stampOf(a.name)) || b.name.localeCompare(a.name))
}

const stampOf = (name: string) => BACKUP_NAME.exec(name)?.[2] ?? ""

/**
 * The files retention deletes: everything the kit wrote beyond the newest `keep`.
 *
 * `justWritten` is never among them, whatever its timestamp says. A server whose clock once ran
 * ahead leaves names that sort after today's, and a rule that trusted the names alone would
 * delete the dump this deploy is relying on. Files the kit did not name are not its to delete.
 */
export function retentionVictims(files: StoredBackup[], keep: number, justWritten: string): string[] {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`retention must be a positive integer, got ${keep}`)
  }
  const kept = new Set([justWritten])
  const victims: string[] = []
  for (const f of ownBackups(files)) {
    if (kept.has(f.name)) continue
    if (kept.size < keep) kept.add(f.name)
    else victims.push(f.name)
  }
  return victims
}

/** What the plan shows as the last verified backup: the newest name and when the server wrote it. */
export function describeNewest(files: StoredBackup[]): string | null {
  const newest = ownBackups(files)[0]
  if (!newest) return null
  return `${newest.name} (${new Date(newest.mtime * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")})`
}

/** The digest on the last line of `out` (`sha256sum` output or a bare digest), or null when there is none. */
export function parseSha256(out: string): string | null {
  const last = out.trim().split("\n").pop() ?? ""
  const first = last.trim().split(/\s+/)[0] ?? ""
  return /^[0-9a-f]{64}$/.test(first) ? first : null
}

/**
 * Validates `backupRetention` from shipkit.yaml. Returns the value, or a message when it is not
 * a positive integer — "keep 0" or "keep 2.5" is a typo, never a request to keep nothing.
 */
export function parseRetention(raw: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: DEFAULT_BACKUP_RETENTION }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, reason: `backupRetention must be a positive integer, got ${JSON.stringify(raw)}` }
  }
  return { ok: true, value: raw }
}

/**
 * Tables in every schema that is not PostgreSQL's own. Read from pg_class rather than
 * information_schema, which only lists tables the connecting role has privileges on — and an
 * application whose tables live outside `public` (EF's HasDefaultSchema) used to look empty,
 * which skipped the backup entirely (B11).
 */
export const TABLE_COUNT =
  "select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace " +
  "where c.relkind in ('r', 'p') and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'"

/** A bare non-negative integer, or null. `Number("")` is 0, which is how an empty answer once read as "no tables". */
export function parseCount(out: string): number | null {
  const text = out.trim()
  return /^\d+$/.test(text) ? Number(text) : null
}

/**
 * Asks production's database container for its table count, over stdin and a quoted heredoc for
 * the same reason as in history.ts: nothing in the query then has to survive a shell.
 * ON_ERROR_STOP makes a failing query a non-zero exit, instead of an empty stdout and a zero one.
 */
export function tableCountScript(db: { dbContainer?: string; dbUser: string; database: string }): string {
  return (
    `docker exec -i ${shq(db.dbContainer ?? "")} psql -v ON_ERROR_STOP=1 -U ${shq(db.dbUser)} -d ${shq(db.database)} -tA ` +
    `<<'SHIPKIT_SQL'\n${TABLE_COUNT}\nSHIPKIT_SQL\n`
  )
}

/**
 * pg_restore into the scratch database, stopping at the first error and exiting non-zero on it.
 *
 * It used to end in `|| true`, on the theory that pg_restore only complains about ownership —
 * which --no-owner and --no-privileges already rule out — and a restore that stopped halfway
 * counted as verified (B3).
 */
export function restoreArgs(host: string, user: string, database: string, archive: string): string[] {
  return [
    "pg_restore", "-h", host, "-U", user, "-d", database,
    "--exit-on-error", "--no-owner", "--no-privileges", archive,
  ]
}

/**
 * Why a restore does not count, or null when it does.
 *
 * At least as many tables as production, not exactly as many: production is counted before the
 * dump, and a table created in between is in the dump but not in the count. One dropped in
 * between shows up as a shortfall, which fails — correctly, since the dump no longer matches
 * what was counted. "More than zero" was the old rule, and three of forty passed it.
 */
export function restoreShortfall(restored: number, production: number): string | null {
  if (restored <= 0) return "the dump restored into an empty database — it parses, but it contains nothing"
  if (restored < production) {
    return `the dump restored ${restored} of production's ${production} tables — a partial restore is not a backup`
  }
  return null
}

/**
 * The shell script that stores a verified dump on the server, run where the dump is.
 *
 * Every step is checked: the directory is created private and must be writable, the upload goes
 * to a hidden temporary name, the server's digest must equal the local one, and only then is the
 * file made owner-only and renamed into place. A rename within one directory is atomic, so a file
 * with a backup's name is always a whole, verified dump; a half-copied one never carries it and
 * retention never counts it. Prints the digest as its last line.
 *
 * `remote` wraps a script so it runs on the server (remoteScript); `upload` copies `local` to
 * `temp` there (scp). Both are passed in so this stays free of SSH details and testable.
 */
export function storeScript(o: {
  local: string
  dir: string
  temp: string
  path: string
  upload: string
  remote: (script: string) => string
}): string {
  return [
    "set -e",
    `local_sum=$(sha256sum ${shq(o.local)} | cut -d' ' -f1)`,
    o.remote(`umask 077 && mkdir -p ${shq(o.dir)} && test -w ${shq(o.dir)}`),
    o.upload,
    `remote_sum=$(${o.remote(`sha256sum ${shq(o.temp)}`)} | cut -d' ' -f1)`,
    `if [ -z "$local_sum" ] || [ "$remote_sum" != "$local_sum" ]; then ` +
      `echo "sha256 differs after upload: local $local_sum, server \${remote_sum:-none}" >&2; exit 1; fi`,
    o.remote(`chmod 600 ${shq(o.temp)} && mv -f ${shq(o.temp)} ${shq(o.path)}`),
    `echo "$local_sum"`,
  ].join("\n")
}

// The same rule as shq() in ssh-command.ts. Kept local, as in server-probe.ts: the tests import
// this file directly, and it can only do that while it imports nothing.
function shq(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}
