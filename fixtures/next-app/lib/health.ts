/**
 * What `/api/health` answers, as a function, so the one rule in it can be tested without a
 * server: the version is the commit, or it is honestly not a commit.
 */
export interface HealthPayload {
  status: "ok"
  version: string
  /** The buildArgs value from shipkit.yaml, echoed so the build cannot lose it unnoticed. */
  label: string
}

/**
 * `sha` is the GIT_SHA build argument, inlined by next.config at build time.
 *
 * An image built without it must not report something that could pass for a commit: `verify`
 * compares this value against the SHA it just deployed (core/health.ts), so "dev" fails that
 * comparison loudly instead of letting an unidentified container count as the release.
 */
export function healthPayload(sha: string | undefined, label = ""): HealthPayload {
  return { status: "ok", version: sha && sha.length > 0 ? sha : "dev", label }
}
