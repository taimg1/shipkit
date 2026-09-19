import type { Environment } from "../config.js"

/**
 * Building the commands sent over SSH — pure, so the quoting can be tested without a server.
 *
 * It is worth its own file because getting this wrong is silent. A query containing
 * `table_schema='public'` once closed the outer quoting, the command became something else,
 * and production reported zero tables — which this pipeline reads as "nothing to back up".
 * A quoting bug that switches off a backup gate is not a cosmetic problem, and nothing about
 * the failure looked like an error.
 */

/**
 * One value as a single POSIX shell word, whatever it contains.
 *
 * Every value from configuration or from a server that is placed into a shell script goes
 * through this — never bare, never inside double quotes, where `$(...)` and backticks still
 * run. Values made only of characters no shell treats specially are left as they are, so the
 * commands stay readable in logs.
 */
export function shq(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The ssh command prefix for this environment, as argv. */
export function sshArgs(env: Environment): string[] {
  return [
    "ssh",
    "-i", "/root/.ssh/id_ed25519",
    "-p", String(env.sshPort),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=/root/.ssh/known_hosts",
    "-o", "BatchMode=yes",
    `${env.sshUser}@${env.host}`,
  ]
}

/**
 * A shell fragment that runs `script` on the server, with no quoting to get wrong.
 *
 * The script is base64-encoded here and decoded there. The obvious alternative — wrapping
 * the remote command in quotes — has to survive two shells, and it does not: a query
 * containing `table_schema='public'` closed the outer quoting and the command silently
 * became something else. That failure reported production as having no tables, which in
 * this pipeline means "no backup needed". A quoting bug that turns a backup gate off is not
 * a cosmetic problem.
 *
 * Encoding also keeps multi-line scripts, pipes and redirections working unchanged.
 */
export function remoteScript(env: Environment, script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return `echo ${encoded} | base64 -d | ${sshPrefix(env)} sh`
}

/** `sshArgs` as a fragment of a local shell command, each argument quoted. */
export function sshPrefix(env: Environment): string {
  return sshArgs(env).map(shq).join(" ")
}

/*
 * The migration bundle: putting it on the server and running it. Here rather than in
 * migrate.ts so that what the remote shell actually parses can be tested by running it.
 *
 * The connection string is the one value here nobody chose with shells in mind. Generated
 * passwords carry `$`, quotes and backslashes, and it used to be expanded into the text of the
 * remote script, where the server's shell parsed it a second time: a `$` in a password broke
 * the migration after the backup had run, and a `$(...)` would have been executed.
 */

/**
 * Where bundles are staged: a directory `mktemp -d` creates, so the name is not guessable and
 * the directory is 0700. A fixed path in /tmp could be prepared in advance by any other user
 * on the server — a symlink, or a file swapped between the copy and the run. Six X's exactly:
 * BusyBox's mktemp randomises only the last six, and a server may well be running it.
 */
export const BUNDLE_DIR_TEMPLATE = "/tmp/shipkit-efbundle.XXXXXX"

/** Remote script that creates the staging directory and prints its path. */
export const makeBundleDirScript = `umask 077 && mktemp -d ${BUNDLE_DIR_TEMPLATE}`

/**
 * The staging directory the server reported, or null when the answer is not one `mktemp` from
 * our template could have produced. Null is refused by the caller: this path is later removed
 * with `rm -rf`, and a surprising answer is not something to delete.
 */
export function parseBundleDir(output: string): string | null {
  const dir = output.trim().split("\n").pop()?.trim() ?? ""
  return /^\/tmp\/shipkit-efbundle\.[A-Za-z0-9]{6,}$/.test(dir) ? dir : null
}

/** Local command that copies the bundle into the staging directory. */
export function copyBundleCommand(env: Environment, localPath: string, dir: string): string {
  return [
    "scp",
    "-i", "/root/.ssh/id_ed25519",
    "-P", String(env.sshPort),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=/root/.ssh/known_hosts",
    "-o", "BatchMode=yes",
    localPath,
    `${env.sshUser}@${env.host}:${dir}/efbundle`,
  ]
    .map(shq)
    .join(" ")
}

/**
 * Local command that runs the staged bundle against the database named by `$dsnVar`.
 *
 * The connection string never becomes script text. This shell base64-encodes it — an alphabet
 * with nothing for a shell to interpret — and sends it ahead of the script as one assignment;
 * the server decodes it into a variable and passes that variable, quoted, as a single argument.
 * The value is only ever expanded, never parsed.
 *
 * It is still an argument of `docker run` on the server for the duration of the migration,
 * visible to `ps`. Accepted rather than hidden: the alternative is writing the credential to
 * the server's disk, and anyone reading that process list already has root on the machine the
 * database runs on.
 */
export function runBundleCommand(
  env: Environment,
  dir: string,
  image: string,
  dsnVar = "SHIPKIT_DB_URL",
): string {
  const bundle = `${dir}/efbundle`
  const script = [
    "set -e",
    `dsn=$(printf '%s' "$SHIPKIT_DSN_B64" | base64 -d)`,
    `[ -n "$dsn" ] || { echo "shipkit: the connection string arrived empty" >&2; exit 1; }`,
    `chmod +x ${shq(bundle)}`,
    `docker run --rm --network ${shq(env.network)} -v ${shq(`${bundle}:/efbundle:ro`)} ` +
      `${shq(image)} /efbundle --connection "$dsn"`,
  ].join("\n")
  const encoded = Buffer.from(script + "\n", "utf8").toString("base64")

  return (
    `{ printf 'SHIPKIT_DSN_B64=%s\\n' "$(printf '%s' "$${dsnVar}" | base64 | tr -d '\\n')"; ` +
    `echo ${encoded} | base64 -d; } | ${sshPrefix(env)} sh`
  )
}

/** Remote script that removes the staging directory and everything in it. */
export function removeBundleDirScript(dir: string): string {
  return `rm -rf -- ${shq(dir)}`
}
