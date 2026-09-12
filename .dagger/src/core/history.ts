import { Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { DbAdapter } from "../adapters/types.js"
import { remoteScript, sshContainer } from "./ssh.js"

/**
 * The last migration production has applied, read from the database itself (decision D5).
 *
 * Nothing else is kept in sync: no deployment metadata, no marker file, no state store. The
 * database already knows, and a second copy of the truth is a second thing that can be wrong.
 *
 * Returns null when the table does not exist yet, which is what a first deploy looks like.
 */
export async function lastApplied(
  env: Environment,
  db: DbAdapter,
  key: Secret,
): Promise<string | null> {
  const query =
    `select "${db.historyIdColumn}" from "${db.historyTable}" ` +
    `order by "${db.historyIdColumn}" desc limit 1`

  const script =
    `docker exec ${env.dbContainer} psql -U ${env.dbUser} -d ${env.database} ` +
    `-tAc "${query}" 2>/dev/null || true`

  const out = await sshContainer(env, key)
    .withExec(["sh", "-c", remoteScript(env, script)])
    .stdout()

  const id = out.trim()
  return id.length > 0 ? id : null
}
