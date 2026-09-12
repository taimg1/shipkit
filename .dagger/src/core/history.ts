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

  // The query goes in on stdin, inside a quoted heredoc. Passing it as -c would mean the
  // identifiers' own double quotes had to survive the remote shell — and they do not: the
  // first `"MigrationId"` closes the argument and the command becomes something else.
  // base64 protects the transport; this protects the script itself.
  const script =
    `docker exec -i ${env.dbContainer} psql -U ${env.dbUser} -d ${env.database} -tA ` +
    `2>/dev/null <<'SHIPKIT_SQL' || true\n${query}\nSHIPKIT_SQL\n`

  const out = await sshContainer(env, key)
    .withExec(["sh", "-c", remoteScript(env, script)])
    .stdout()

  const id = out.trim()
  return id.length > 0 ? id : null
}
