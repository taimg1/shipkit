import { Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { infraError } from "../errors.js"
import { remoteScript, shq, sshContainer } from "./ssh.js"

/**
 * Waits until production's database container accepts connections.
 *
 * A freshly booted Postgres initialises its data directory before it listens; the backup that
 * follows would otherwise fail on a database that is merely still starting.
 */
export async function waitForDatabase(env: Environment, key: Secret, seconds = 90): Promise<void> {
  const script =
    `i=0; while [ $i -lt ${seconds} ]; do ` +
    // Over TCP on purpose. On first boot the image runs initdb and the init scripts against a
    // temporary server that listens on the unix socket only, then restarts it; a socket check
    // passes during that window and the next query fails. Seen on dev-server.
    `docker exec ${shq(env.dbContainer ?? "")} pg_isready -h 127.0.0.1 -U ${shq(env.dbUser)} -d ${shq(env.database)} >/dev/null 2>&1 && exit 0; ` +
    `i=$((i+1)); sleep 1; done; exit 1`
  try {
    await sshContainer(env, key).withExec(["sh", "-c", remoteScript(env, script)]).sync()
  } catch {
    throw infraError(
      `the database container did not accept connections within ${seconds}s of booting`,
      `Check \`docker logs ${env.dbContainer}\` on the server.`,
    )
  }
}
