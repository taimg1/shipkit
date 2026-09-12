import { Container, Secret } from "@dagger.io/dagger"
import { Config } from "../config.js"
import { EXIT, ShipkitError } from "../errors.js"

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
  if (cfg.registry.length === 0) {
    throw new ShipkitError(
      EXIT.CONFIG,
      "no registry configured",
      'Set "registry" in shipkit.yaml, e.g. ghcr.io/<owner>/<image>.',
    )
  }

  const address = `${cfg.registry}:${tag}`
  const registryHost = cfg.registry.split("/")[0]

  let publishable = image
  if (token) {
    publishable = image.withRegistryAuth(registryHost, username ?? "shipkit", token)
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
      token
        ? "Check that the token can write packages to this registry."
        : "No registry token was provided. Pass --registry-token for a registry that requires authentication.",
    )
  }
}
