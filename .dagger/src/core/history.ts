import { Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { DbAdapter } from "../adapters/types.js"
import { EXIT, ShipkitError } from "../errors.js"
import { historyProbeSql, lastAppliedSql, parseHistoryProbe } from "./history-probe.js"
import { remoteScript, shq, sshContainer } from "./ssh.js"

/**
 * The last migration production has applied, read from the database itself (decision D5).
 *
 * Nothing else is kept in sync: no deployment metadata, no marker file, no state store. The
 * database already knows, and a second copy of the truth is a second thing that can be wrong.
 *
 * Returns null only when the history table does not exist, which is what a first deploy looks
 * like. Anything that prevents reading it fails the stage: an unreadable history is not an empty
 * one (#12).
 */
export async function lastApplied(
  env: Environment,
  db: DbAdapter,
  key: Secret,
): Promise<string | null> {
  const probe = parseHistoryProbe(await runSql(env, key, historyProbeSql(db.historyTable)), db.historyTable, db.historyIdColumns)

  if (probe.kind === "absent") return null
  if (probe.kind === "unreadable") {
    throw new ShipkitError(
      EXIT.GATE,
      `cannot read production's migration history: ${probe.reason}`,
      "Deploy stops here rather than assume nothing has been applied. Check that the database " +
        "container, user and database in shipkit.yaml are right, then plan again.",
    )
  }

  const id = (await runSql(env, key, lastAppliedSql(db.historyTable, probe.column))).trim()
  // The table exists but is empty: EF creates it before applying the first migration, so a
  // deploy that failed half-way through its very first migration looks like this.
  return id.length > 0 ? id : null
}

/**
 * Runs SQL against production's database and returns its output, failing on any error.
 *
 * The query goes in on stdin, inside a quoted heredoc: passed as -c, the identifiers' own double
 * quotes would have to survive the remote shell, and they do not. base64 protects the transport;
 * the heredoc protects the script. ON_ERROR_STOP makes psql exit non-zero on a SQL error, and
 * stderr is kept, so a failure arrives as a failure with its message.
 */
async function runSql(env: Environment, key: Secret, sql: string): Promise<string> {
  const script =
    `docker exec -i ${shq(env.dbContainer ?? "")} psql -U ${shq(env.dbUser)} -d ${shq(env.database)} ` +
    `-v ON_ERROR_STOP=1 -tA <<'SHIPKIT_SQL'\n${sql}\nSHIPKIT_SQL\n`

  return sshContainer(env, key)
    .withExec(["sh", "-c", remoteScript(env, script)])
    .stdout()
}
