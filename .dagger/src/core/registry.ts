/**
 * What a registry address has to look like, and what to say when publishing to it fails.
 *
 * Pure, and free of runtime imports, so it can be tested without Dagger or a registry —
 * the same reason core/publish-gate.ts is split out. Turning a problem into a ShipkitError
 * is core/push.ts's job.
 */

/** The username the kit authenticates as when the project names none. */
export const DEFAULT_REGISTRY_USER = "shipkit"

/**
 * Why `registry` in shipkit.yaml is not something an image can be published to, or null.
 *
 * Every one of these was tried against a real registry that required a password. They all
 * failed, and they all failed as exit 3 with "check that the token can write packages here" —
 * infrastructure's fault, according to the pipeline, for a value a person typed. The shape is
 * knowable before anything is uploaded, so it is checked here and reported as configuration.
 *
 * The rules are Docker's own reference grammar, in the order a reader would check them.
 */
export function registryProblem(registry: string): { message: string; next: string } | null {
  const bad = (message: string, next: string) => ({ message: `shipkit.yaml: ${message}`, next })

  if (registry.length === 0) {
    return bad("no registry configured", 'Set "registry", e.g. ghcr.io/<owner>/<image>.')
  }
  if (/\s/.test(registry)) {
    return bad(`registry "${registry}" contains whitespace`, "Write it as one word: host/path.")
  }
  if (registry.includes("@")) {
    return bad(
      `registry "${registry}" carries a digest`,
      "Name the repository only; the kit appends :sha-<commit> and the registry answers with the digest.",
    )
  }

  const slash = registry.indexOf("/")
  if (slash < 0) {
    return bad(
      `registry "${registry}" names no repository`,
      "It is <host>/<path>, e.g. ghcr.io/<owner>/<image>. Without the path the image would be published as <host>:<tag>.",
    )
  }
  const host = registry.slice(0, slash)
  const path = registry.slice(slash + 1)

  // Docker reads the first component as a registry host only when it has a dot or a port, or
  // is localhost. Anything else is a Docker Hub namespace — and the credentials would then be
  // registered for a host that is never contacted, so the push goes out unauthenticated.
  if (!/[.:]/.test(host) && host !== "localhost") {
    return bad(
      `registry "${registry}" does not start with a registry host`,
      `Docker reads "${host}" as a Docker Hub namespace, not a host, and the token would be sent nowhere. ` +
        "Write the host out, e.g. ghcr.io/<owner>/<image> or docker.io/<owner>/<image>.",
    )
  }
  if (path.includes(":")) {
    return bad(
      `registry "${registry}" carries a tag`,
      "Name the repository only; the kit tags every image with the commit it was built from.",
    )
  }
  if (path.split("/").some((segment) => segment.length === 0)) {
    return bad(
      `registry "${registry}" has an empty path segment`,
      "No leading, trailing or doubled slashes: ghcr.io/<owner>/<image>.",
    )
  }
  // Docker's own path grammar: lowercase alphanumerics, separated by . _ __ or one or more -.
  if (!/^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/.test(path)) {
    return bad(
      `registry "${registry}" is not a repository name a registry accepts`,
      "Lowercase letters, digits and . _ - only — a capital letter in an organisation name is the usual cause.",
    )
  }
  return null
}

/**
 * What to do about a failed publish.
 *
 * A 401 is the username as much as the token, and the username is the one thing nobody passed
 * on purpose: outside GitHub Actions it used to default to "shipkit" with no way to change it,
 * so a correct token still got "unauthorized" and the advice was to check the token. It names
 * itself now. Pure, for the same reason as the rest of this file.
 */
export function pushFailureHint(user: string | undefined, host: string): string {
  if (user === undefined) {
    return `No registry token was provided. Export SHIPKIT_REGISTRY_TOKEN for a registry that requires authentication (${host}).`
  }
  return (
    `Check that "${user}" can write packages to ${host} and that the token has not expired. ` +
    "The username is sent with the token: it comes from SHIPKIT_REGISTRY_USER, else GITHUB_ACTOR, " +
    `else "${DEFAULT_REGISTRY_USER}".`
  )
}
