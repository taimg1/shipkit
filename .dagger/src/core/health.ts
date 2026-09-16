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

/**
 * Whether the version a server reports is the one a tag names.
 *
 * A rollback is asked for by tag — `sha-a1b2c3d`, what the registry holds — while /health
 * reports the full commit SHA. Comparing them for equality would fail every time, and
 * comparing them loosely would let any version pass. The tag's hex is a prefix of the SHA,
 * so that is what is checked, and only when the tag has that shape at all.
 */
export function versionMatchesTag(version: string | null, tag: string): boolean {
  if (version === null) return false
  const m = /^sha-([0-9a-f]{7,40})$/.exec(tag)
  // A tag the kit did not mint cannot be checked this way; refuse rather than wave it through.
  if (!m) return false
  return version.startsWith(m[1])
}
