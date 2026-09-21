import { Container, Secret } from "@dagger.io/dagger"
import { Config } from "../config.js"
import { EXIT, ShipkitError } from "../errors.js"
import { DEFAULT_REGISTRY_USER, pushFailureHint, registryProblem } from "./registry.js"

/**
 * Publishes the image built by the `build` stage.
 *
 * Only merges to the default branch publish anything. A branch build that pushed an image
 * would put unreviewed code in the registry under a tag that looks exactly like a released
 * one, and rollback picks images by tag.
 */
export async function push(
  image: Container,
  cfg: Config,
  tag: string,
  token?: Secret,
  username?: string,
): Promise<string> {
  const problem = registryProblem(cfg.registry)
  if (problem) throw new ShipkitError(EXIT.CONFIG, problem.message, problem.next)

  const address = `${cfg.registry}:${tag}`
  const registryHost = cfg.registry.split("/")[0]
  const user = username && username.length > 0 ? username : DEFAULT_REGISTRY_USER

  let publishable = image
  if (token) {
    publishable = image.withRegistryAuth(registryHost, user, token)
  }

  try {
    // publish() returns the address including the content digest, which is what a rollback
    // should really pin to — a tag can be moved, a digest cannot.
    return await publishable.publish(address)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ShipkitError(
      EXIT.INFRA,
      `publishing to ${address} failed: ${message}`,
      pushFailureHint(token ? user : undefined, registryHost),
    )
  }
}
