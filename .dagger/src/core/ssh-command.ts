import type { Environment } from "../config.js"

/**
 * Building the commands sent over SSH — pure, so the quoting can be tested without a server.
 *
 * It is worth its own file because getting this wrong is silent. A query containing
 * `table_schema='public'` once closed the outer quoting, the command became something else,
 * and production reported zero tables — which this pipeline reads as "nothing to back up".
 * A quoting bug that switches off a backup gate is not a cosmetic problem, and nothing about
 * the failure looked like an error.
 */

/** The ssh command prefix for this environment, as argv. */
export function sshArgs(env: Environment): string[] {
  return [
    "ssh",
    "-i", "/root/.ssh/id_ed25519",
    "-p", String(env.sshPort),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=/root/.ssh/known_hosts",
    "-o", "BatchMode=yes",
    `${env.sshUser}@${env.host}`,
  ]
}

/**
 * A shell fragment that runs `script` on the server, with no quoting to get wrong.
 *
 * The script is base64-encoded here and decoded there. The obvious alternative — wrapping
 * the remote command in quotes — has to survive two shells, and it does not: a query
 * containing `table_schema='public'` closed the outer quoting and the command silently
 * became something else. That failure reported production as having no tables, which in
 * this pipeline means "no backup needed". A quoting bug that turns a backup gate off is not
 * a cosmetic problem.
 *
 * Encoding also keeps multi-line scripts, pipes and redirections working unchanged.
 */
export function remoteScript(env: Environment, script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return `echo ${encoded} | base64 -d | ${sshArgs(env).join(" ")} sh`
}
