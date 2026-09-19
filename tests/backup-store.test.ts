import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BACKUP_ROOT,
  DEFAULT_BACKUP_RETENTION,
  backupDir,
  backupFileName,
  describeNewest,
  listingScript,
  parseListing,
  parseRetention,
  parseCount,
  parseSha256,
  restoreArgs,
  restoreShortfall,
  retentionVictims,
  storeScript,
  tableCountScript,
} from "../.dagger/src/core/backup-store.ts"

const at = new Date("2026-09-19T12:34:56.789Z")
const file = (name: string, mtime = 1_790_000_000, bytes = 4096) => ({ name, mtime, bytes })

test("a backup is named after the commit and the UTC time", () => {
  assert.equal(backupFileName("a1b2c3d4e5f6", at), "a1b2c3d-20260919T123456Z.pgc")
})

test("a sha that is not hex-ish cannot put a path in the name", () => {
  assert.equal(backupFileName("../../etc", at), "etc-20260919T123456Z.pgc")
  assert.equal(backupFileName("", at), "unknown-20260919T123456Z.pgc")
})

test("each service gets its own directory under the backup root", () => {
  assert.equal(backupDir("client-api"), `${BACKUP_ROOT}/client-api`)
})

test("a service name that could leave the backup root is refused", () => {
  for (const bad of ["", "..", "a/b", "../etc", "a b", "$(reboot)", "-rf", "a..b"]) {
    assert.equal(backupDir(bad), null, bad)
  }
})

test("the listing reports a missing directory as such, not as an error", () => {
  assert.deepEqual(parseListing("SHIPKIT_BACKUPS_NONE\n"), { ok: true, exists: false, files: [] })
})

test("an empty directory is a finished listing with no files", () => {
  assert.deepEqual(parseListing("SHIPKIT_BACKUPS_END\n"), { ok: true, exists: true, files: [] })
})

test("an empty answer is not an empty directory", () => {
  // A dropped connection says nothing at all; reading that as "no backups" is how a plan would
  // claim there is nothing to restore from because it failed to look.
  const r = parseListing("")
  assert.equal(r.ok, false)
})

test("a listing cut off before its end marker is refused", () => {
  const r = parseListing("1790000000 4096 a1b2c3d-20260919T123456Z.pgc\n")
  assert.equal(r.ok, false)
})

test("reads mtime, size and name from each line", () => {
  const r = parseListing("1790000000 4096 a1b2c3d-20260919T123456Z.pgc\nSHIPKIT_BACKUPS_END\n")
  assert.deepEqual(r, { ok: true, exists: true, files: [file("a1b2c3d-20260919T123456Z.pgc")] })
})

test("the listing script says where it looks and ends with the marker", () => {
  const s = listingScript("/var/backups/shipkit/client-api")
  assert.match(s, /\[ -d \/var\/backups\/shipkit\/client-api \]/)
  assert.match(s, /echo SHIPKIT_BACKUPS_END$/)
})

test("a file the listing cannot stat stops the listing instead of being skipped", () => {
  // Found by running it: where `stat -c` failed, every file was skipped and the directory
  // listed as empty — "never backed up", from a directory full of backups.
  assert.match(listingScript("/var/backups/shipkit/api"), /stat -c '%Y %s %n' "\$f" \|\| exit 3/)
})

test("retention keeps the newest N by the timestamp in the name", () => {
  const files = [
    file("aaaaaaa-20260101T000000Z.pgc"),
    file("bbbbbbb-20260301T000000Z.pgc"),
    file("ccccccc-20260201T000000Z.pgc"),
    file("ddddddd-20260401T000000Z.pgc"),
  ]
  assert.deepEqual(retentionVictims(files, 2, "ddddddd-20260401T000000Z.pgc"), [
    "ccccccc-20260201T000000Z.pgc",
    "aaaaaaa-20260101T000000Z.pgc",
  ])
})

test("mtime does not decide what is newest — a touched old dump is still old", () => {
  const files = [
    file("aaaaaaa-20260101T000000Z.pgc", 1_900_000_000),
    file("bbbbbbb-20260301T000000Z.pgc", 1_700_000_000),
  ]
  assert.deepEqual(retentionVictims(files, 1, "bbbbbbb-20260301T000000Z.pgc"), [
    "aaaaaaa-20260101T000000Z.pgc",
  ])
})

test("the dump just written is never deleted, even when its name sorts oldest", () => {
  // A server clock that once ran ahead leaves names from the future. Trusting the names alone
  // would delete the backup this deploy is about to rely on.
  const files = [
    file("fffffff-20991231T000000Z.pgc"),
    file("eeeeeee-20991230T000000Z.pgc"),
    file("a1b2c3d-20260919T123456Z.pgc"),
  ]
  const victims = retentionVictims(files, 1, "a1b2c3d-20260919T123456Z.pgc")
  assert.ok(!victims.includes("a1b2c3d-20260919T123456Z.pgc"))
  assert.deepEqual(victims.sort(), ["eeeeeee-20991230T000000Z.pgc", "fffffff-20991231T000000Z.pgc"])
})

test("files the kit did not name are never deleted", () => {
  const files = [
    file("manual-copy.pgc"),
    file("notes.txt"),
    file("a1b2c3d-20260919T123456Z.pgc"),
    file("0000000-20250101T000000Z.pgc"),
  ]
  assert.deepEqual(retentionVictims(files, 1, "a1b2c3d-20260919T123456Z.pgc"), [
    "0000000-20250101T000000Z.pgc",
  ])
})

test("fewer backups than the retention deletes nothing", () => {
  assert.deepEqual(retentionVictims([file("a1b2c3d-20260919T123456Z.pgc")], 10, "a1b2c3d-20260919T123456Z.pgc"), [])
})

test("retention below one is a programming error, not a request to delete everything", () => {
  assert.throws(() => retentionVictims([], 0, "x"))
  assert.throws(() => retentionVictims([], 1.5, "x"))
})

test("the plan shows the newest backup with the server's time", () => {
  const files = [
    file("aaaaaaa-20260101T000000Z.pgc", 1_767_225_600),
    file("bbbbbbb-20260301T000000Z.pgc", 1_772_323_200),
    file("unrelated.pgc", 1_900_000_000),
  ]
  assert.equal(describeNewest(files), "bbbbbbb-20260301T000000Z.pgc (2026-03-01T00:00:00Z)")
})

test("no backups of the kit's own means never", () => {
  assert.equal(describeNewest([]), null)
  assert.equal(describeNewest([file("unrelated.pgc")]), null)
})

test("reads a digest from sha256sum output or a bare line", () => {
  const d = "a".repeat(64)
  assert.equal(parseSha256(`${d}  /var/backups/shipkit/x/.y.partial\n`), d)
  assert.equal(parseSha256(`${d}\n`), d)
})

test("anything that is not a digest is null, never a pass", () => {
  assert.equal(parseSha256(""), null)
  assert.equal(parseSha256("sha256sum: not found"), null)
  assert.equal(parseSha256("abc123"), null)
})

test("backupRetention defaults to 10", () => {
  assert.deepEqual(parseRetention(undefined), { ok: true, value: DEFAULT_BACKUP_RETENTION })
  assert.equal(DEFAULT_BACKUP_RETENTION, 10)
})

test("backupRetention accepts a positive integer", () => {
  assert.deepEqual(parseRetention(3), { ok: true, value: 3 })
})

test("backupRetention refuses zero, negatives, fractions and strings", () => {
  for (const bad of [0, -1, 2.5, "10", true, Number.NaN]) {
    assert.equal(parseRetention(bad).ok, false, String(bad))
  }
})

// --- the restore check (B3/C6) and the production table count (B11) ---

test("a table count is a bare number or nothing", () => {
  assert.equal(parseCount("42\n"), 42)
  assert.equal(parseCount(" 0 "), 0)
})

test("an empty or unreadable table count is null, never zero", () => {
  // Zero means "nothing to back up". `Number("")` is 0, and that is how an empty psql answer
  // once switched the backup off.
  for (const bad of ["", "\n", "ERROR:  relation does not exist", "12 rows", "-1", "1.5", "NaN"]) {
    assert.equal(parseCount(bad), null, JSON.stringify(bad))
  }
})

test("production's table count stops on the first SQL error", () => {
  const s = tableCountScript({ dbContainer: "api-db", dbUser: "postgres", database: "app" })
  assert.match(s, /psql -v ON_ERROR_STOP=1 -U postgres -d app -tA/)
  assert.match(s, /<<'SHIPKIT_SQL'\n/)
})

test("tables are counted in every schema, not just public", () => {
  const s = tableCountScript({ dbContainer: "api-db", dbUser: "postgres", database: "app" })
  assert.doesNotMatch(s, /table_schema\s*=\s*'public'/)
  assert.match(s, /pg_catalog\.pg_class/)
})

test("pg_restore stops on the first error and nothing swallows its exit code", () => {
  const args = restoreArgs("scratch", "postgres", "restore_check", "/dump.pgc")
  assert.ok(args.includes("--exit-on-error"))
  assert.equal(args[0], "pg_restore")
  // An argv, not a shell string: there is no `|| true` to hide behind.
  assert.ok(!args.some((a) => a.includes("||")))
})

test("a restore with every table production has is verified", () => {
  assert.equal(restoreShortfall(40, 40), null)
})

test("a table created between counting and dumping does not fail the check", () => {
  assert.equal(restoreShortfall(41, 40), null)
})

test("a partial restore is refused", () => {
  assert.match(restoreShortfall(3, 40) ?? "", /3 of production's 40 tables/)
})

test("a restore into nothing is refused", () => {
  assert.match(restoreShortfall(0, 40) ?? "", /empty database/)
})

// --- storing the dump on the server (B1/C1) ---

const stored = () =>
  storeScript({
    local: "/backup/dump.pgc",
    dir: "/var/backups/shipkit/api",
    temp: "/var/backups/shipkit/api/.a1b2c3d-20260919T123456Z.pgc.partial",
    path: "/var/backups/shipkit/api/a1b2c3d-20260919T123456Z.pgc",
    upload: "SCP",
    remote: (script) => `REMOTE[${script}]`,
  })

test("storing stops at the first failed step", () => {
  assert.equal(stored().split("\n")[0], "set -e")
})

test("the dump is uploaded to a hidden temporary name, never straight to its final one", () => {
  const lines = stored().split("\n")
  const upload = lines.indexOf("SCP")
  const rename = lines.findIndex((l) => l.includes("mv -f"))
  assert.ok(upload > 0 && rename > upload)
  assert.match(lines[rename], /REMOTE\[chmod 600 \S+\.partial && mv -f \S+\.partial \/var\/backups\/shipkit\/api\/a1b2c3d-20260919T123456Z\.pgc\]/)
})

test("the digests are compared before the rename, and a difference stops it", () => {
  const lines = stored().split("\n")
  const compare = lines.findIndex((l) => l.includes('"$remote_sum" != "$local_sum"'))
  const rename = lines.findIndex((l) => l.includes("mv -f"))
  assert.ok(compare > 0 && compare < rename)
  assert.match(lines[compare], /exit 1/)
  assert.match(stored(), /REMOTE\[sha256sum \S+\.partial\]/)
})

test("an empty local digest is not a match for an empty remote one", () => {
  // Both sides failing would otherwise compare "" to "" and pass.
  assert.match(stored(), /\[ -z "\$local_sum" \]/)
})

test("the backup directory is created private and must be writable", () => {
  assert.match(stored(), /REMOTE\[umask 077 && mkdir -p \/var\/backups\/shipkit\/api && test -w \/var\/backups\/shipkit\/api\]/)
})

test("the digest is the script's last line of output", () => {
  assert.equal(stored().split("\n").pop(), 'echo "$local_sum"')
})
