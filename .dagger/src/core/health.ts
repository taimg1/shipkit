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

/**
 * What one attempt of gate 4 saw. Statuses are HTTP codes; 0 means nothing answered at all.
 * `ready` is null when no readiness path is configured.
 */
export interface Observation {
  health: { status: number; body: string }
  ready: { status: number; body: string } | null
}

export type Verdict =
  | { ok: true; version: string }
  | { ok: false; why: "unreachable" | "version" | "not-ready"; version: string | null; readyStatus?: number }

/**
 * Whether one attempt proves the release: the expected version is answering /health AND the
 * application can reach its database.
 *
 * Every failure is a reason to try again until the deadline, not a verdict. A stale version
 * for a second or two is what a proxy mid-switch or a cache in front of the URL looks like; a
 * rollback triggered by that is a false alarm that undoes a good deploy (B20).
 *
 * The version alone was not enough: /health deliberately touches no dependency, so an
 * application with a wrong database password passed it, and so did one whose schema had been
 * dropped (C4). Readiness is what says the release can serve anything.
 */
export function judge(obs: Observation, matches: (version: string) => boolean): Verdict {
  if (obs.health.status < 200 || obs.health.status > 299) {
    return { ok: false, why: "unreachable", version: null }
  }
  const version = readVersion(obs.health.body)
  if (version === null || !matches(version)) return { ok: false, why: "version", version }

  if (obs.ready !== null) {
    if (obs.ready.status !== 200) {
      return { ok: false, why: "not-ready", version, readyStatus: obs.ready.status }
    }
    // Readiness from a different container than /health just answered from is not readiness
    // of this release. A body without a version says nothing either way and is accepted.
    const readyVersion = readVersion(obs.ready.body)
    if (readyVersion !== null && !matches(readyVersion)) return { ok: false, why: "version", version: readyVersion }
  }
  return { ok: true, version }
}

/**
 * The shell side of one attempt: `<name>_status:<code>` and `<name>_body:<base64>` per URL.
 * Bodies travel as base64 so a newline or a colon in them cannot be mistaken for a field.
 */
export function probeScript(healthUrl: string, readyUrl: string | null): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const one = (name: string, url: string) =>
    `code=$(curl -sS --max-time 5 -o /tmp/body -w '%{http_code}' ${q(url)} 2>/dev/null) || code=0\n` +
    `echo "${name}_status:$code"\n` +
    `echo "${name}_body:$(base64 -w 0 /tmp/body 2>/dev/null)"\n` +
    `rm -f /tmp/body\n`
  return one("health", healthUrl) + (readyUrl ? one("ready", readyUrl) : "")
}

export function parseProbe(output: string, withReady: boolean): Observation {
  const fields = new Map<string, string>()
  for (const line of output.split("\n")) {
    const m = /^(health|ready)_(status|body):(.*)$/.exec(line.trim())
    if (m) fields.set(`${m[1]}_${m[2]}`, m[3])
  }
  const read = (name: string) => {
    const status = Number(fields.get(`${name}_status`))
    const body = Buffer.from(fields.get(`${name}_body`) ?? "", "base64").toString("utf8")
    // Anything that is not a status code is nothing answering: never a pass by accident.
    return { status: Number.isInteger(status) ? status : 0, body }
  }
  return { health: read("health"), ready: withReady ? read("ready") : null }
}

/** How long gate 4 keeps trying when shipkit.yaml does not say. Matches the old 20 × 3s. */
export const DEFAULT_VERIFY_TIMEOUT = 60
/** The most it may be told to wait. A gate that can wait forever is a hung deploy. */
export const MAX_VERIFY_TIMEOUT = 600

export type VerifySettings =
  | { ok: true; ready: string | undefined; verifyTimeout: number }
  | { ok: false; message: string; next: string }

/**
 * `ready` and `verifyTimeout` from shipkit.yaml. Returned rather than thrown so this file stays
 * free of imports and testable without Dagger; config.ts turns a refusal into a config error.
 *
 * `ready` is required whenever there is a database. Without it gate 4 cannot tell a release
 * that serves from one that only reports its version — which is how a rotated password with
 * a stale application passed verify (C4). There is no default path: guessing one would either
 * 404 on every project that named it differently or, worse, hit something that always says 200.
 */
export function verifySettings(raw: Record<string, unknown>, db: string): VerifySettings {
  const ready = raw.ready
  if (ready !== undefined && (typeof ready !== "string" || !ready.startsWith("/"))) {
    return { ok: false, message: `ready must be a path starting with "/"`, next: "For example: ready: /health/ready" }
  }
  if (ready === undefined && db !== "none") {
    return {
      ok: false,
      message: 'shipkit.yaml: "ready" is required when db is not "none"',
      next:
        "Add ready: <path> — an endpoint that answers 200 only when the application can reach its " +
        "database (the fixture's is /health/ready). verify requires it after every release.",
    }
  }

  const t = raw.verifyTimeout ?? DEFAULT_VERIFY_TIMEOUT
  if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > MAX_VERIFY_TIMEOUT) {
    return {
      ok: false,
      message: `verifyTimeout must be a whole number of seconds between 1 and ${MAX_VERIFY_TIMEOUT}`,
      next: `Leave it out for the default of ${DEFAULT_VERIFY_TIMEOUT}.`,
    }
  }
  return { ok: true, ready: ready as string | undefined, verifyTimeout: t }
}
