export { planToken, digest, renderPlan } from "./plan-token.js"
export type { DeployPlan } from "./plan-token.js"

import { DeployPlan, digest, planToken } from "./plan-token.js"
import { Directory, Secret, dag } from "@dagger.io/dagger"
import { Config, Environment } from "../config.js"
import { StackAdapter } from "../adapters/types.js"
import { currentVersion } from "./release.js"
import { lastApplied } from "./history.js"
import { parseAllowedLosses, stripBom } from "./sql-scan.js"
import { servingVersion as servingHealthVersion } from "./verify.js"
import { EXIT, ShipkitError, configError } from "../errors.js"
import { ServerState, parseServerProbe, provisioning, serverProbeScript } from "./server-probe.js"
import { dockerPlatform, SUPPORTED_RIDS } from "./platform.js"
import { remoteScript, sshContainer } from "./ssh.js"
import { hostKeyHint, sshHostKeyRefusal } from "./known-hosts.js"
import { execOutput } from "../report.js"
import { imageTag as tagFor, publishedDigest } from "./publish-gate.js"
import { newestBackup } from "./backup.js"
import { DEFAULT_REGISTRY_USER } from "./registry.js"

/** Asks the server what exists on it. An answer the kit cannot read stops the plan. */
export async function probeServer(cfg: Config, env: Environment, key: Secret): Promise<ServerState> {
  let out: string
  try {
    out = await sshContainer(env, key)
      .withExec(["sh", "-c", remoteScript(env, serverProbeScript(cfg.service, env.dbContainer))])
      .stdout()
  } catch (err) {
    // The first SSH of every deploy, so this is where a wrong pin surfaces. "exit code: 255"
    // on its own reads as a network problem.
    const refused = sshHostKeyRefusal(execOutput(err) ?? "")
    if (refused) throw configError(refused, hostKeyHint(env.host ?? "<host>", env.sshPort))
    throw err
  }
  const probe = parseServerProbe(out)
  if (!probe.ok) {
    throw new ShipkitError(EXIT.INFRA, `cannot read the state of the server: ${probe.reason}`)
  }
  return probe.state
}

/**
 * The digest the registry serves for `tag`, or null when nothing answers for it.
 *
 * The plan names an image and, until now, took its existence on trust: `deploy` only found out
 * at the release stage, by which time the backup had run and the schema had already moved. The
 * registry is asked here instead, before anything is changed, so the plan can state it.
 *
 * Only the manifest is resolved, never the layers — the image is pulled onto the server by
 * Kamal, not into this engine.
 *
 * Never throws. A registry that cannot be reached is reported as "no image", which is what it
 * means for every decision made from this: a deploy still needs a token, and a run that would
 * approve itself must not do so on an image nobody could confirm exists.
 */
async function publishedImage(
  cfg: Config,
  tag: string,
  registryPassword?: Secret,
  registryUser?: string,
): Promise<string | null> {
  // A project that publishes nothing has no registry to ask, and asking anyway would spend a
  // network round trip per plan to learn what shipkit.yaml already says.
  if (!cfg.publish || cfg.registry.length === 0) return null

  const address = `${cfg.registry}:${tag}`
  const host = cfg.registry.split("/")[0]
  // The same username push() sends. Hardcoding one here made a published image look absent on
  // any registry that does not take "shipkit" — a self-approval refused for the wrong reason,
  // which is the least useful way to fail closed. Found against a private registry.
  const user = registryUser && registryUser.length > 0 ? registryUser : DEFAULT_REGISTRY_USER
  try {
    let c = dag.container()
    if (registryPassword) c = c.withRegistryAuth(host, user, registryPassword)
    return publishedDigest(await c.from(address).imageRef())
  } catch {
    return null
  }
}

/**
 * Gathers everything a person needs in order to say yes, from the places that actually know:
 * the running version from the server, the applied migrations from the database.
 *
 * Nothing here is read from the pipeline's own idea of the world. What a deploy is about to
 * do depends on the state production is in, and that is exactly what a stale assumption gets
 * wrong.
 */
export async function buildPlan(
  source: Directory,
  cfg: Config,
  envName: string,
  env: Environment,
  adapter: StackAdapter,
  sha: string,
  key: Secret,
  healthPath: string,
  registryPassword?: Secret,
  registryUser?: string,
  /** The stages the deploy will run (selectedStages); null for all. Part of the token (B7). */
  stages: string[] | null = null,
): Promise<DeployPlan> {
  const imageTag = tagFor(sha)
  const needsDb = cfg.db !== "none" && !!adapter.db

  // The server first: everything below reads it, and each read used to turn "could not ask"
  // into "nothing there" (#13).
  const server = await probeServer(cfg, env, key)
  const building = dockerPlatform(cfg.targetArch)
  if (building === null) {
    throw new ShipkitError(
      EXIT.CONFIG,
      `targetArch "${cfg.targetArch}" is not a runtime identifier the kit can build an image for`,
      `Use one of: ${SUPPORTED_RIDS.join(", ")}.`,
    )
  }
  const provision = provisioning(server, needsDb, building)
  if (!provision.ok) throw new ShipkitError(EXIT.GATE, provision.reason, provision.next)

  // Nothing of this app has ever run here: there is no version to ask Kamal for. Otherwise Kamal
  // must answer — a failure to read the current version is not "nothing deployed", and the
  // current version is the rollback target.
  let currentImageTag: string | null = null
  if (server.appContainers > 0) {
    currentImageTag = await currentVersion(source, env, key, registryPassword)
    if (currentImageTag === null) {
      throw new ShipkitError(
        EXIT.INFRA,
        "the application has run on this server but Kamal could not say which version is deployed",
        "Run `kamal app version` against the server and fix what it reports before planning a deploy.",
      )
    }
  }
  const servingVersion = await servingHealthVersion(env, healthPath)

  let migrations: string[] = []
  let sqlText = ""
  if (needsDb && adapter.db) {
    // A database that has not been booted yet has no history to read.
    const from = server.db === "missing" ? null : await lastApplied(env, adapter.db, key)
    migrations = await adapter.db.pendingList(source, cfg, from)
    if (migrations.length > 0) {
      sqlText = stripBom(await adapter.db.sqlBetween(source, cfg, from, null).contents())
    }
  }

  const base: Omit<DeployPlan, "token"> = {
    env: envName,
    url: env.url,
    imageTag,
    currentImageTag,
    servingVersion,
    provision: provision.steps,
    migrations,
    sqlDigest: digest(sqlText),
    sqlPreview:
      migrations.length === 0
        ? "no schema change"
        : `${sqlText.split("\n").filter((l) => l.trim().length > 0).length} lines`,
    destructive: /\b(DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN)\b/i.test(sqlText),
    // What the author has written down as acceptable to lose. Read once, here, so the gates
    // and the self-approval policy cannot disagree about which losses were waived.
    allowLoss: parseAllowedLosses(sqlText),
    imageDigest: await publishedImage(cfg, imageTag, registryPassword, registryUser),
    // Read from the server's backup directory, where only verified dumps are ever renamed into
    // place. Not part of the token: taking a backup between plan and deploy changes nothing the
    // confirmation was about.
    lastVerifiedBackup: needsDb ? await newestBackup(env, key, cfg.service) : null,
    stages,
  }

  return { ...base, token: planToken(base) }
}
