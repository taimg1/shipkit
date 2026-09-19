export { planToken, digest, renderPlan } from "./plan-token.js"
export type { DeployPlan } from "./plan-token.js"

import { DeployPlan, digest, planToken } from "./plan-token.js"
import { Directory, Secret } from "@dagger.io/dagger"
import { Config, Environment } from "../config.js"
import { StackAdapter } from "../adapters/types.js"
import { currentVersion } from "./release.js"
import { lastApplied } from "./history.js"
import { stripBom } from "./sql-scan.js"
import { servingVersion as servingHealthVersion } from "./verify.js"
import { EXIT, ShipkitError } from "../errors.js"
import { ServerState, parseServerProbe, provisioning, serverProbeScript } from "./server-probe.js"
import { dockerPlatform, SUPPORTED_RIDS } from "./platform.js"
import { remoteScript, sshContainer } from "./ssh.js"
import { newestBackup } from "./backup.js"

/** Asks the server what exists on it. An answer the kit cannot read stops the plan. */
export async function probeServer(cfg: Config, env: Environment, key: Secret): Promise<ServerState> {
  const out = await sshContainer(env, key)
    .withExec(["sh", "-c", remoteScript(env, serverProbeScript(cfg.service, env.dbContainer))])
    .stdout()
  const probe = parseServerProbe(out)
  if (!probe.ok) {
    throw new ShipkitError(EXIT.INFRA, `cannot read the state of the server: ${probe.reason}`)
  }
  return probe.state
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
): Promise<DeployPlan> {
  const imageTag = `sha-${sha.slice(0, 7)}`
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
    // Read from the server's backup directory, where only verified dumps are ever renamed into
    // place. Not part of the token: taking a backup between plan and deploy changes nothing the
    // confirmation was about.
    lastVerifiedBackup: needsDb ? await newestBackup(env, key, cfg.service) : null,
  }

  return { ...base, token: planToken(base) }
}
