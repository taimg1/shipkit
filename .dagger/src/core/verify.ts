import { dag, ReturnType } from "@dagger.io/dagger"
import { Environment } from "../config.js"
import { verifyFailed } from "./gates.js"
import { readVersion } from "./health.js"

export interface VerifyResult {
  version: string
  attempts: number
  url: string
}

/**
 * Gate 4 — the smoke test.
 *
 * It does not check for 200. A 200 from the PREVIOUS container is the failure this exists
 * to catch: the release did not take, the old version is still serving, and every
 * status-code check in the world calls that a success. The only question worth asking is
 * whether the SHA that was just deployed is the one answering.
 */
export async function verify(
  env: Environment,
  healthPath: string,
  expected: string,
  attempts = 20,
  intervalSeconds = 3,
): Promise<VerifyResult> {
  const url = `${env.url.replace(/\/$/, "")}${healthPath}`

  const script =
    `for i in $(seq 1 ${attempts}); do\n` +
    `  body=$(curl -fsS --max-time 5 "${url}" 2>/dev/null) && {\n` +
    `    echo "$body"; exit 0; }\n` +
    `  sleep ${intervalSeconds}\n` +
    `done\n` +
    `echo "__unreachable__"\n`

  const out = await dag
    .container()
    .from("alpine:3.21")
    .withExec(["apk", "add", "--no-cache", "curl"])
    .withEnvVariable("SHIPKIT_NO_CACHE", Date.now().toString())
    .withExec(["sh", "-c", script], { expect: ReturnType.Any })
    .stdout()

  const body = out.trim()
  if (body === "__unreachable__" || body.length === 0) {
    throw verifyFailed(expected, null)
  }

  const version = readVersion(body)
  if (version !== expected) throw verifyFailed(expected, version)

  return { version, attempts, url }
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
    .from("alpine:3.21")
    .withExec(["apk", "add", "--no-cache", "curl"])
    .withEnvVariable("SHIPKIT_NO_CACHE", Date.now().toString())
    .withExec(["sh", "-c", `curl -fsS --max-time 5 "${url}" || true`], { expect: ReturnType.Any })
    .stdout()
  return readVersion(out.trim())
}
