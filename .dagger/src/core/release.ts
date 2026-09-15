import { dag, Container, Directory, Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { infraError } from "../errors.js"

/**
 * Pinned. Kamal is the delivery layer; an unpinned delivery tool means a deploy can change
 * behaviour without anything in the repository changing.
 */
const KAMAL_IMAGE = "ghcr.io/basecamp/kamal:v2.12.0"

/**
 * Kamal, with the project mounted and an SSH key it can use.
 *
 * The kit passes `--version` and nothing else; `config/deploy.yml` belongs to the project
 * and is never edited from here (ADR 0001). What Kamal does with it — the proxy, the health
 * check, the container swap — is Kamal's business, and the kit does not reimplement any of it.
 */
export function kamal(
  source: Directory,
  _env: Environment,
  key: Secret,
  registryPassword?: Secret,
): Container {
  let c = dag
    .container()
    .from(KAMAL_IMAGE)
    .withDirectory("/workdir", source)
    .withWorkdir("/workdir")
    .withMountedSecret("/root/.ssh/id_ed25519", key)
    // Kamal asks the server what is running; a cached answer would describe a past deploy.
    .withEnvVariable("SHIPKIT_NO_CACHE", Date.now().toString())

  if (registryPassword) {
    c = c.withSecretVariable("KAMAL_REGISTRY_PASSWORD", registryPassword)
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
): Promise<string | null> {
  const out = await kamal(source, env, key, registryPassword)
    .withExec(["kamal", "app", "version"], { expect: "ANY" as never })
    .stdout()

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
): Promise<void> {
  await kamal(source, env, key, registryPassword)
    // --skip-push: `ci` published this image already. Rebuilding here would produce a
    // different artifact from the one the gates were run against.
    .withExec(["kamal", "deploy", "--version", tag, "--skip-push"])
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
  await kamal(source, env, key, registryPassword)
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
): Promise<string> {
  const out = await kamal(source, env, key, registryPassword)
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
): Promise<void> {
  // --version even though an accessory has nothing to do with the app's image: without it Kamal
  // derives a version from git, and the source it is given has no .git. Every other Kamal call
  // here already passes it; this one was found missing on the first real first-deploy.
  await kamal(source, env, key, registryPassword)
    .withExec(["kamal", "accessory", "boot", "db", "--version", tag])
    .sync()
}
