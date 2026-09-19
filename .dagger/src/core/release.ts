import { dag, Container, Directory, Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { EXIT, ShipkitError, configError, infraError } from "../errors.js"
import { KAMAL_IMAGE } from "./images.js"
import { hostKeyRefusal, kamalHostKeyProblem } from "./kamal-config.js"
import { STRICT_SSH_CONFIG, hostKeyHint, knownHostsFor } from "./known-hosts.js"
import { remoteScript, sshContainer } from "./ssh.js"
import { LockHolder, lockAcquireScript, lockReleaseScript, parseLockAcquire, unlockCommand } from "./deploy-lock.js"

/**
 * Kamal, with the project mounted and an SSH key it can use.
 *
 * The kit passes `--version` and nothing else; `config/deploy.yml` belongs to the project
 * and is never edited from here (ADR 0001). What Kamal does with it — the proxy, the health
 * check, the container swap — is Kamal's business, and the kit does not reimplement any of it.
 *
 * It does not get to trust the server on sight, though. The pinned hostKey is its only
 * known_hosts entry and ~/.ssh/config switches strict checking on; a deploy.yml that would stop
 * Kamal reading that file is refused before Kamal runs (kamalHostKeyProblem).
 */
export async function kamal(
  source: Directory,
  env: Environment,
  key: Secret,
  registryPassword?: Secret,
  /**
   * The project's .kamal/secrets with its references already resolved. Mounted over whatever
   * the source carries, because what the source carries is a list of variable names and this
   * container has none of those variables (#19).
   */
  kamalSecrets?: Secret,
): Promise<Container> {
  let knownHosts: string
  try {
    knownHosts = knownHostsFor(env)
  } catch (e) {
    throw configError((e as Error).message, hostKeyHint(env.host ?? "<host>", env.sshPort))
  }
  let deployYml: string
  try {
    deployYml = await source.file("config/deploy.yml").contents()
  } catch {
    throw configError("config/deploy.yml not found", "Kamal needs it; see fixtures/dotnet-api/config/deploy.yml.")
  }
  const problem = kamalHostKeyProblem(deployYml)
  if (problem) {
    throw configError(problem, "Remove ssh.config from config/deploy.yml; the kit supplies the ssh config.")
  }

  let c = dag
    .container()
    .from(KAMAL_IMAGE)
    .withDirectory("/workdir", source)
    .withWorkdir("/workdir")
    .withMountedSecret("/root/.ssh/id_ed25519", key)
    .withNewFile("/root/.ssh/known_hosts", knownHosts)
    .withNewFile("/root/.ssh/config", STRICT_SSH_CONFIG)
    // Kamal asks the server what is running; a cached answer would describe a past deploy.
    .withEnvVariable("SHIPKIT_NO_CACHE", Date.now().toString())

  if (registryPassword) {
    c = c.withSecretVariable("KAMAL_REGISTRY_PASSWORD", registryPassword)
  }
  if (kamalSecrets) {
    c = c.withMountedSecret("/workdir/.kamal/secrets", kamalSecrets)
  }
  return c
}

/**
 * The version currently serving, according to the server.
 *
 * Asked rather than assumed: this is the rollback target, and the pipeline's idea of what is
 * deployed is exactly the thing that is wrong when a rollback is needed.
 */
export async function currentVersion(
  source: Directory,
  env: Environment,
  key: Secret,
  registryPassword?: Secret,
  kamalSecrets?: Secret,
): Promise<string | null> {
  const ran = (await kamal(source, env, key, registryPassword, kamalSecrets))
    .withExec(["kamal", "app", "version"], { expect: "ANY" as never })
  const out = await ran.stdout()

  // Any failure here reads as "nothing deployed yet". A refused host key must not: that is
  // the pin doing its job, and the answer is to stop, not to plan a first deploy.
  const refused = hostKeyRefusal(`${out}\n${await ran.stderr()}`)
  if (refused) {
    throw infraError(
      `Kamal refused the server's host key: ${refused}`,
      "The server did not present the key pinned as hostKey in shipkit.yaml. See docs/runbooks/deploy.md.",
    )
  }

  // The version is the last non-empty line; everything before it is SSHKit's log.
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("INFO") && !l.startsWith("App Host"))
    .pop()

  return line && /^[A-Za-z0-9._-]+$/.test(line) ? line : null
}

/** Zero-downtime container swap. The image is already in the registry; this only pulls it. */
export async function release(
  source: Directory,
  env: Environment,
  key: Secret,
  tag: string,
  registryPassword?: Secret,
  kamalSecrets?: Secret,
): Promise<void> {
  await (await kamal(source, env, key, registryPassword, kamalSecrets))
    // --skip-push: `ci` published this image already. Rebuilding here would produce a
    // different artifact from the one the gates were run against.
    .withExec(["kamal", "deploy", "--version", tag, "--skip-push"])
    .sync()
}

/**
 * Pulls the release image onto the servers, the way `release` will — before anything changes.
 *
 * `release` passes --skip-push, so the image must already be in the registry. When it was not
 * (a branch never published, a red CI run, a typo'd sha) that was discovered at release: after
 * the backup and after the migrations, with production on the new schema and the old code
 * (B4). This is Kamal's own pull — `kamal deploy --skip-push` runs exactly this step — so it
 * asks the registry deploy.yml names, with the credentials Kamal will use, from the servers
 * that will run it, and it validates the image's service label as release would. A registry
 * the pipeline can reach but the server cannot is not "available".
 *
 * It takes no Kamal lock (`build pull` does not), so it cannot collide with Kamal's.
 */
export async function pullImage(
  source: Directory,
  env: Environment,
  key: Secret,
  tag: string,
  registryPassword?: Secret,
  kamalSecrets?: Secret,
): Promise<void> {
  await kamal(source, env, key, registryPassword, kamalSecrets)
    .withExec(["kamal", "build", "pull", "--version", tag])
    .sync()
}

/**
 * Puts the previous image back.
 *
 * The database is NOT rolled back. Application rollback and database rollback are separate
 * concerns (ADR 0005) — migrations roll forward, and the verified backup is what exists for
 * the other case.
 */
export async function rollback(
  source: Directory,
  env: Environment,
  key: Secret,
  toTag: string,
  registryPassword?: Secret,
  kamalSecrets?: Secret,
): Promise<void> {
  if (!toTag) {
    throw infraError(
      "nothing to roll back to: no previous version was recorded before the release",
    )
  }
  // Two things this got wrong, both found only by making a deploy fail on purpose:
  //
  //  - `kamal rollback` rejects --skip-push outright. It was there by analogy with release.
  //  - Kamal still derives a version for its deploy lock from git, and the source handed to
  //    it has no git history. `--version` is passed explicitly for the same reason as in
  //    clean(): the pipeline knows which release this is, and a delivery tool guessing that
  //    is a guess that can be wrong at the worst possible moment.
  //
  // A recovery path that has never been executed is not a recovery path. This one was broken
  // from the day it was written and looked fine.
  await (await kamal(source, env, key, registryPassword, kamalSecrets))
    .withExec(["kamal", "rollback", toTag, "--version", toTag])
    .sync()
}

/**
 * Prune old containers and images, so a server does not fill up over a year of deploys.
 *
 * `--version` is passed explicitly. Kamal otherwise derives a version from the git history,
 * and the source handed to it deliberately has none — but more to the point, the version is
 * something this pipeline already knows. A delivery tool guessing which release it is
 * operating on is a guess that can be wrong at the worst moment.
 */
export async function clean(
  source: Directory,
  env: Environment,
  key: Secret,
  tag: string,
  registryPassword?: Secret,
  kamalSecrets?: Secret,
): Promise<string> {
  const out = await (await kamal(source, env, key, registryPassword, kamalSecrets))
    .withExec(["kamal", "prune", "all", "--version", tag])
    .stdout()

  const steps = out
    .split("\n")
    .filter((l) => l.includes("Finished in") && l.includes("successful")).length
  return `${steps} prune step(s) completed`
}

/**
 * Boots the database accessory on a server that has never had one — the part of `kamal setup`
 * a first deploy needs (#13). Only ever runs when the confirmed plan says so.
 */
export async function bootDatabase(
  source: Directory,
  env: Environment,
  key: Secret,
  tag: string,
  registryPassword?: Secret,
  kamalSecrets?: Secret,
): Promise<void> {
  // --version even though an accessory has nothing to do with the app's image: without it Kamal
  // derives a version from git, and the source it is given has no .git. Every other Kamal call
  // here already passes it; this one was found missing on the first real first-deploy.
  await (await kamal(source, env, key, registryPassword, kamalSecrets))
    .withExec(["kamal", "accessory", "boot", "db", "--version", tag])
    .sync()
}

/** Takes the server-side deploy lock (deploy-lock.ts) or refuses. Never waits. */
export async function acquireDeployLock(env: Environment, key: Secret, service: string, holder: LockHolder) {
  const out = await sshContainer(env, key)
    .withExec(["sh", "-c", remoteScript(env, lockAcquireScript(service, holder))])
    .stdout()
  const got = parseLockAcquire(out)
  if (got.ok) return
  if (got.held) {
    throw new ShipkitError(
      EXIT.GATE,
      `another deploy holds the lock on ${env.host}: ${got.holder}`,
      "Wait for it to finish. If no deploy is running (it was killed mid-run), check the server " +
        `is in the state you expect, then remove the lock on the server: ${unlockCommand(service)} ` +
        "(docs/runbooks/deploy.md).",
    )
  }
  throw new ShipkitError(EXIT.INFRA, `could not take the deploy lock on ${env.host}: ${got.reason}`)
}

/**
 * Releases the lock if it is still ours. Never throws: it runs after the outcome is decided,
 * and a failure here must not replace the reason the deploy failed. What happened is returned
 * for the report — a lock left behind makes the next deploy refuse, with the unlock command.
 */
export async function releaseDeployLock(env: Environment, key: Secret, service: string, id: string) {
  try {
    const out = await sshContainer(env, key)
      .withExec(["sh", "-c", remoteScript(env, lockReleaseScript(service, id))])
      .stdout()
    const answer = out.trim()
    if (answer === "RELEASED") return { released: true }
    return { released: false, reason: answer || "no answer", unlock: unlockCommand(service) }
  } catch (err) {
    return {
      released: false,
      reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
      unlock: unlockCommand(service),
    }
  }
}
