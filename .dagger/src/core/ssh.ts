import { dag, Container, Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { remoteScript, sshArgs } from "./ssh-command.js"
import { configError } from "../errors.js"
import { ALPINE_IMAGE } from "./images.js"
import { hostKeyHint, knownHostsFor } from "./known-hosts.js"

/**
 * A container that can reach the deploy target over SSH, with psql available for reading
 * and restoring dumps.
 *
 * The key arrives as a Secret and is mounted, never passed as an argument or baked into a
 * layer. The server's key is the environment's `hostKey`, written as the only known_hosts
 * entry and checked with StrictHostKeyChecking=yes: a server that presents anything else is
 * refused. This used to be `accept-new`, which against a known_hosts file that is empty in
 * every new container meant trusting whoever answered, on every connection.
 */
export function sshContainer(env: Environment, key: Secret): Container {
  if (!env.host) {
    throw configError(
      "this environment has no host",
      'Add "host" to the environment in shipkit.yaml once the server exists.',
    )
  }
  let knownHosts: string
  try {
    knownHosts = knownHostsFor(env)
  } catch (e) {
    throw configError((e as Error).message, hostKeyHint(env.host, env.sshPort))
  }

  return dag
    .container()
    .from(ALPINE_IMAGE)
    .withExec(["apk", "add", "--no-cache", "openssh-client", "postgresql17-client"])
    .withMountedSecret("/root/.ssh/id_ed25519", key)
    .withNewFile("/root/.ssh/known_hosts", knownHosts)
    .withExec(["mkdir", "-p", "/out"])
    // Nothing about the target is cached: a deploy must look at the server as it is now,
    // not as it was when this layer was built.
    .withEnvVariable("SHIPKIT_NO_CACHE", Date.now().toString())
}

export { hostKeyOptions, remoteScript, shq, sshArgs } from "./ssh-command.js"
