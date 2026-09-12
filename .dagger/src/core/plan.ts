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
  const currentImageTag = await currentVersion(source, env, key, registryPassword)
  const servingVersion = await servingHealthVersion(env, healthPath)

  let migrations: string[] = []
  let sqlText = ""
  if (cfg.db !== "none" && adapter.db) {
    const from = await lastApplied(env, adapter.db, key)
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
    migrations,
    sqlDigest: digest(sqlText),
    sqlPreview:
      migrations.length === 0
        ? "no schema change"
        : `${sqlText.split("\n").filter((l) => l.trim().length > 0).length} lines`,
    destructive: /\b(DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN)\b/i.test(sqlText),
    lastVerifiedBackup: null,
  }

  return { ...base, token: planToken(base) }
}
