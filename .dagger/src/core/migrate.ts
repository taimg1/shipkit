import { Container, Directory, Secret } from "@dagger.io/dagger"
import { Config, Environment } from "../config.js"
import { DbAdapter } from "../adapters/types.js"
import { ShipkitError, EXIT } from "../errors.js"
import { remoteScript, sshArgs, sshContainer } from "./ssh.js"
import type { BackupResult } from "./backup.js"

/**
 * A glibc runtime with no SDK and no source — what a self-contained bundle needs and nothing
 * more. The bundle runs here rather than on the host itself, so the host's distribution is
 * irrelevant: an Alpine server cannot run a glibc-linked bundle directly, and discovering
 * that during a deploy is expensive.
 */
const BUNDLE_RUNNER = "mcr.microsoft.com/dotnet/runtime-deps:10.0"

export interface MigrateResult {
  applied: string[]
  from: string | null
}

/**
 * Applies pending migrations to production using a migration bundle.
 *
 * Never from the application, never at startup: with more than one instance two processes
 * race, the application would need DDL privileges permanently, and a failure would happen at
 * boot in front of users with no way back (ADR 0005).
 */
export async function migrate(
  src: Directory,
  cfg: Config,
  env: Environment,
  db: DbAdapter,
  key: Secret,
  dbUrl: Secret,
  pending: string[],
  backup: BackupResult | null,
): Promise<MigrateResult> {
  // Gate 2, and the only two acceptable answers: a dump that was proven restorable, or a
  // production database that has nothing in it yet. Anything else — including "the backup
  // stage was skipped" — stops here.
  if (!backup) {
    throw new ShipkitError(
      EXIT.GATE,
      "migrate was reached without a backup result",
      "The backup stage must run first. Run the whole deploy, not just this stage.",
    )
  }
  if (pending.length === 0) {
    return { applied: [], from: null }
  }

  const bundle = db.applyArtifact(src, cfg).file("/out/efbundle")
  const remotePath = `/tmp/shipkit-efbundle-${Date.now()}`
  const ssh = sshArgs(env).join(" ")

  const scp =
    `scp -i /root/.ssh/id_ed25519 -P ${env.sshPort} ` +
    `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts ` +
    `/bundle/efbundle ${env.sshUser}@${env.host}:${remotePath}`

  // $SHIPKIT_DB_URL is expanded by the shell inside THIS container, where the value arrives
  // as a mounted secret — it is never written into the script text or a Dagger layer.
  //
  // It does become an argument on the server for the duration of the migration, where `ps`
  // could see it. Accepted rather than hidden: the alternative is writing the credential to
  // the server's disk, and anyone who can read that process list already has root on the
  // machine the database runs on.
  // Building the remote script at RUNTIME, inside this container, is what lets the secret
  // take part without ever being written into a Dagger layer: $SHIPKIT_DB_URL is expanded
  // by this shell, the result is base64-encoded on the spot, and the server decodes and runs
  // it. Nothing has to survive two levels of quoting, so a connection string containing a
  // quote or a space cannot rewrite the command.
  //
  // The DSN is still an argument on the server for the duration of the migration, visible to
  // `ps`. Accepted rather than hidden: the alternative is writing the credential to the
  // server's disk, and anyone reading that process list already has root on the machine the
  // database runs on.
  const runBundle =
    `printf '%s\\n' ` +
    `"set -e" ` +
    `"chmod +x ${remotePath}" ` +
    `"docker run --rm --network ${env.network} -v ${remotePath}:/efbundle:ro ` +
    `${BUNDLE_RUNNER} /efbundle --connection \\"$SHIPKIT_DB_URL\\"" ` +
    `| base64 | tr -d '\\n' | ${ssh} 'base64 -d | sh'`

  const runner = sshContainer(env, key)
    .withMountedFile("/bundle/efbundle", bundle)
    .withSecretVariable("SHIPKIT_DB_URL", dbUrl)
    .withExec(["sh", "-c", scp])
    .withExec(["sh", "-c", runBundle])

  try {
    await runner.sync()
  } finally {
    // Removed whether or not the migration succeeded. Leaving a 100MB executable on a
    // client's server after every deploy is its own kind of failure.
    await sshContainer(env, key)
      .withExec(["sh", "-c", remoteScript(env, `rm -f ${remotePath}`)])
      .sync()
  }

  return { applied: pending, from: pending[0] ?? null }
}
