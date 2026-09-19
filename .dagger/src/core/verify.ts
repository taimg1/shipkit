import { dag, ReturnType } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { notReady, verifyFailed } from "./gates.js"
import { judge, parseProbe, probeScript, readVersion, Verdict } from "./health.js"
import { ALPINE_IMAGE } from "./images.js"
import { shq } from "./ssh-command.js"

export interface VerifyResult {
  version: string
  attempts: number
  url: string
  /** The readiness URL that answered 200, when one is configured. */
  ready?: string
}

export interface VerifyPaths {
  health: string
  /** Readiness path. Required by config whenever there is a database. */
  ready?: string
}

/**
 * Gate 4 — the smoke test.
 *
 * It does not check for 200. A 200 from the PREVIOUS container is the failure this exists
 * to catch: the release did not take, the old version is still serving, and every
 * status-code check in the world calls that a success. The question is whether the SHA that
 * was just deployed is the one answering — and, since /health touches nothing, whether it can
 * reach its database at all (C4): `ready` must answer 200 too.
 *
 * Everything short of both is retried until `timeoutSeconds`, a stale version included (B20).
 * Only when the deadline passes does the last observation become the verdict.
 *
 * `matches` decides what counts as the expected version: equality with the SHA after a
 * release, a tag prefix after a rollback (see versionMatchesTag).
 */
export async function verify(
  env: Environment,
  paths: VerifyPaths,
  expected: string,
  timeoutSeconds: number,
  matches: (version: string) => boolean = (v) => v === expected,
  intervalSeconds = 3,
): Promise<VerifyResult> {
  const base = env.url.replace(/\/$/, "")
  const url = `${base}${paths.health}`
  const readyUrl = paths.ready ? `${base}${paths.ready}` : null
  const script = probeScript(url, readyUrl)

  const curl = dag.container().from(ALPINE_IMAGE).withExec(["apk", "add", "--no-cache", "curl"])
  const deadline = Date.now() + timeoutSeconds * 1000
  let attempts = 0
  let last: Verdict

  for (;;) {
    attempts++
    const out = await curl
      .withEnvVariable("SHIPKIT_NO_CACHE", `${Date.now()}-${attempts}`)
      .withExec(["sh", "-c", script], { expect: ReturnType.Any })
      .stdout()
    last = judge(parseProbe(out, readyUrl !== null), matches)
    if (last.ok) return { version: last.version, attempts, url, ...(readyUrl ? { ready: readyUrl } : {}) }
    if (Date.now() + intervalSeconds * 1000 >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000))
  }

  const err =
    last.why === "not-ready"
      ? notReady(paths.ready!, last.readyStatus ?? 0, last.version!)
      : verifyFailed(expected, last.version)
  err.detail = { attempts, timeoutSeconds, url, ...(readyUrl ? { ready: readyUrl } : {}) }
  throw err
}

export { readVersion } from "./health.js"

/**
 * What the running application reports, or null if it cannot be reached.
 *
 * Deliberately does not throw: this is used to describe the world in a plan, and a target
 * that is down is a fact worth showing rather than an error that hides the rest of the plan.
 */
export async function servingVersion(
  env: Environment,
  healthPath: string,
): Promise<string | null> {
  const url = `${env.url.replace(/\/$/, "")}${healthPath}`
  const out = await dag
    .container()
    .from(ALPINE_IMAGE)
    .withExec(["apk", "add", "--no-cache", "curl"])
    .withEnvVariable("SHIPKIT_NO_CACHE", Date.now().toString())
    .withExec(["sh", "-c", `curl -fsS --max-time 5 ${shq(url)} || true`], { expect: ReturnType.Any })
    .stdout()
  return readVersion(out.trim())
}
