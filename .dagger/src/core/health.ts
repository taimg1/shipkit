/**
 * Reading a health response — pure, so the one thing gate 4 depends on can be tested
 * without a server.
 */

/**
 * Reads the version out of a health response.
 *
 * Kept tolerant about shape but strict about absence: a body with no version at all is a
 * failure, not a pass. A health endpoint that forgot to report its version cannot be used
 * to tell two releases apart, which makes the gate meaningless.
 */
export function readVersion(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const v = parsed.version ?? parsed.Version
    return typeof v === "string" && v.length > 0 ? v : null
  } catch {
    return null
  }
}
