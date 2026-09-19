import { dag, Container, Secret } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { remoteScript, sshArgs } from "./ssh-command.js"
import { configError } from "../errors.js"
import { ALPINE_IMAGE } from "./images.js"

/**
 * A container that can reach the deploy target over SSH, with psql available for reading
 * and restoring dumps.
 *
 * The key arrives as a Secret and is mounted, never passed as an argument or baked into a
 * layer. `accept-new` rather than `no` for host keys: the first connection is trusted, a
 * changed key afterwards is refused, which is the strongest thing available without a
 * known_hosts file to distribute.
 */
export function sshContainer(env: Environment, key: Secret): Container {
  if (!env.host) {
    throw configError(
      "this environment has no host",
      'Add "host" to the environment in shipkit.yaml once the server exists.',
    )
  }

  return dag
    .container()
    .from(ALPINE_IMAGE)
    .withExec(["apk", "add", "--no-cache", "openssh-client", "postgresql17-client"])
    .withMountedSecret("/root/.ssh/id_ed25519", key)
    .withExec(["mkdir", "-p", "/out"])
    // Nothing about the target is cached: a deploy must look at the server as it is now,
    // not as it was when this layer was built.
    .withEnvVariable("SHIPKIT_NO_CACHE", Date.now().toString())
}

export { remoteScript, sshArgs } from "./ssh-command.js"
