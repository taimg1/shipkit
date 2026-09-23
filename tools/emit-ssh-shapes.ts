/**
 * Emits every remote script the shipkit pipeline sends over SSH, built by the module's own
 * pure functions — not by transcribing them.
 *
 * The point of building them rather than listing them: the deploy key's allow-list
 * (server/bootstrap.sh, SHAPES) has to stay in step with what the module actually sends, and a
 * transcribed list drifts the first time someone edits a script and not the copy of it. Run it
 * against the test server with tools/replay-ssh-shapes.py — docs/runbooks/deploy-key.md.
 *
 * One JSON object per line:
 *   { name, kind: "script" | "local", text }
 * "script" is what arrives on the remote sh's stdin; "local" is a whole local shell command
 * (scp, or the bundle runner, which prepends an assignment before the script).
 */
const CORE = new URL("../.dagger/src/core", import.meta.url).pathname

const { serverProbeScript, containerVersionsScript } = await import(`${CORE}/server-probe.ts`)
const { listingScript, tableCountScript, storeScript, backupDir, backupFileName } =
  await import(`${CORE}/backup-store.ts`)
const { lockAcquireScript, lockReleaseScript, lockDir } = await import(`${CORE}/deploy-lock.ts`)
const sshc = await import(`${CORE}/ssh-command.ts`)
const { runtimeDepsImage } = await import(`${CORE}/images.ts`)
const { makeBundleDirScript, removeBundleDirScript, copyBundleCommand, copyDumpCommand,
        runBundleCommand, shq, remoteScript, sshPrefix } = sshc

// The test environment, shaped like shipkit.yaml would produce it.
const env = {
  url: "http://173.242.58.240",
  host: "173.242.58.240",
  sshPort: 22,
  sshUser: "deploy",
  dbContainer: "shipkit-probe-db",
  network: "kamal",
  database: "probe",
  dbUser: "postgres",
} as any

const SERVICE = "shipkit-probe"
const SHA = "sha-0123456789abcdef0123456789abcdef01234567"
const dir = backupDir(SERVICE)!
const name = backupFileName(SHA, new Date("2026-09-22T10:00:00Z"))
const path = `${dir}/${name}`
const temp = `${dir}/.${name}.partial`
const bundleDir = "/tmp/shipkit-efbundle.aB3xY9"

const out: { name: string; kind: string; text: string }[] = []
const script = (name: string, text: string) => out.push({ name, kind: "script", text })
const local = (name: string, text: string) => out.push({ name, kind: "local", text })

// --- plan.ts ---
script("plan/server-probe", serverProbeScript(SERVICE, env.dbContainer))
// --- history.ts (runSql): the EF history probe and lastApplied ---
const sql = `SELECT "MigrationId" FROM "__EFMigrationsHistory" ORDER BY "MigrationId" DESC LIMIT 1;`
script("history/run-sql",
  `docker exec -i ${shq(env.dbContainer)} psql -U ${shq(env.dbUser)} -d ${shq(env.database)} ` +
  `-v ON_ERROR_STOP=1 -tA <<'SHIPKIT_SQL'\n${sql}\nSHIPKIT_SQL\n`)
// --- backup.ts ---
script("backup/table-count", tableCountScript(env))
script("backup/pg-dump",
  `docker exec ${shq(env.dbContainer)} pg_dump -Fc -U ${shq(env.dbUser)} ${shq(env.database)}`)
script("backup/store-mkdir", `umask 077 && mkdir -p ${shq(dir)} && test -w ${shq(dir)}`)
script("backup/store-sha256", `sha256sum ${shq(temp)}`)
script("backup/store-commit", `chmod 600 ${shq(temp)} && mv -f ${shq(temp)} ${shq(path)}`)
script("backup/store-cleanup", `rm -f ${temp}`)
script("backup/listing", listingScript(dir))
script("backup/retention", `cd ${shq(dir)} && rm -f -- ${shq("old-one.pgc")} ${shq("old-two.pgc")}`)
// The upload is taken from the module, not spelled out again here: a hand-written copy of it
// would be exactly the drift this file exists to prevent.
local("backup/scp-dump", storeScript({
  local: "/backup/dump.pgc", dir, temp, path,
  upload: copyDumpCommand(env, "/backup/dump.pgc", temp),
  remote: (s: string) => remoteScript(env, s),
}))
// --- migrate.ts ---
script("migrate/mktemp", makeBundleDirScript)
script("migrate/rm-bundle-dir", removeBundleDirScript(bundleDir))
local("migrate/scp-bundle", copyBundleCommand(env, "/bundle/efbundle", bundleDir))
local("migrate/run-bundle",
  runBundleCommand(env, bundleDir, runtimeDepsImage("10.0")!,
    { pgOptions: "-c lock_timeout=5s -c statement_timeout=0" }))
// --- release.ts / deploy-lock.ts ---
script("release/container-versions", containerVersionsScript(SERVICE))
script("lock/acquire", lockAcquireScript(SERVICE,
  { id: "abc123", sha: SHA, env: "test", actor: "ci-key-probe" }))
script("lock/release", lockReleaseScript(SERVICE, "abc123"))
// --- postgres-remote.ts ---
script("db/wait-for-database",
  `i=0; while [ $i -lt 90 ]; do ` +
  `docker exec ${shq(env.dbContainer)} pg_isready -h 127.0.0.1 -U ${shq(env.dbUser)} -d ${shq(env.database)} >/dev/null 2>&1 && exit 0; ` +
  `i=$((i+1)); sleep 1; done; exit 1`)

for (const o of out) console.log(JSON.stringify(o))
console.error(`# ${out.length} shapes; lock dir ${lockDir(SERVICE)}; ssh prefix: ${sshPrefix(env)}`)
