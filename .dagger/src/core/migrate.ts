import { Container, Directory, Secret } from "@dagger.io/dagger"
import { Config, Environment } from "../config.js"
import { DbAdapter } from "../adapters/types.js"
import { ShipkitError, EXIT, infraError } from "../errors.js"
import { remoteScript, sshContainer } from "./ssh.js"
import {
  copyBundleCommand,
  makeBundleDirScript,
  parseBundleDir,
  removeBundleDirScript,
  runBundleCommand,
} from "./ssh-command.js"
import type { BackupResult } from "./backup.js"

/**
 * A glibc runtime with no SDK and no source — what a self-contained bundle needs and nothing
 * more. The bundle runs here rather than on the host itself, so the host's distribution is
 * irrelevant: an Alpine server cannot run a glibc-linked bundle directly, and discovering
 * that during a deploy is expensive.
 */
const bundleRunner = (version: string) => `mcr.microsoft.com/dotnet/runtime-deps:${version}`

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

  // A private staging directory, created by the server and reported back. Anything that does
  // not look like what mktemp makes stops the migration: the path is removed with rm -rf below.
  const made = await sshContainer(env, key)
    .withExec(["sh", "-c", remoteScript(env, makeBundleDirScript)])
    .stdout()
  const dir = parseBundleDir(made)
  if (!dir) {
    throw infraError(
      `could not create a private directory for the migration bundle on the server; it said: ${made.trim().slice(0, 200)}`,
      "Check that mktemp exists and /tmp is writable for the SSH user, then deploy again.",
    )
  }

  const runner = sshContainer(env, key)
    .withMountedFile("/bundle/efbundle", bundle)
    // Mounted as a secret and read by the shell at run time, so it is never written into the
    // script text or a Dagger layer. How it reaches the server is in ssh-command.ts.
    .withSecretVariable("SHIPKIT_DB_URL", dbUrl)
    .withExec(["sh", "-c", copyBundleCommand(env, "/bundle/efbundle", dir)])
    .withExec(["sh", "-c", runBundleCommand(env, dir, bundleRunner(cfg.stackVersion))])

  try {
    await runner.sync()
  } finally {
    // Removed whether or not the migration succeeded. Leaving a 100MB executable on a
    // client's server after every deploy is its own kind of failure.
    await sshContainer(env, key)
      .withExec(["sh", "-c", remoteScript(env, removeBundleDirScript(dir))])
      .sync()
  }

  return { applied: pending, from: pending[0] ?? null }
}
