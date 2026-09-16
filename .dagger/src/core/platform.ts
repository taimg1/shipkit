/**
 * The architecture an image is built for.
 *
 * `dockerBuild()` with no platform builds for whatever machine the engine happens to run on.
 * In CI that is amd64 and everything works. On an Apple Silicon workstation it is arm64, and
 * the same commands produce an image that an x86 server cannot execute.
 *
 * What makes it expensive is *when* it surfaces. Deploy runs
 * `provision -> backup -> migrate -> release`, and release is the first stage that starts a
 * container. So the migrations have already been applied when the container dies with
 * "exec format error", and on a first deploy there is no previous version to roll back to.
 *
 * dev-server never caught it: it ran as arm64 on the same Mac that built the images, so the
 * simulation agreed with itself. The same shape as #13 and #15.
 *
 * The architecture is not a new setting. `targetArch` already has to match the server, because
 * the migration bundle is compiled self-contained for it — one value, two consumers.
 *
 * What the *server* is belongs to core/server-probe.ts, which is where the two are compared.
 *
 * Pure, and deliberately free of runtime imports, so it can be tested without Dagger. Turning
 * an unknown value into a ShipkitError is the caller's job for the same reason.
 */

/** .NET runtime identifiers to Docker platforms. musl differs in libc, not in architecture. */
const PLATFORM_BY_RID: Record<string, string> = {
  "linux-x64": "linux/amd64",
  "linux-musl-x64": "linux/amd64",
  "linux-arm64": "linux/arm64",
  "linux-musl-arm64": "linux/arm64",
  "linux-arm": "linux/arm/v7",
}

/** The runtime identifiers an image can be built for, for the caller's error message. */
export const SUPPORTED_RIDS = Object.keys(PLATFORM_BY_RID)

/**
 * The Docker platform to build for, from shipkit.yaml's `targetArch`, or null if the kit does
 * not know that runtime identifier.
 *
 * Null must be refused by the caller, never defaulted: guessing here produces an image that
 * builds, publishes, and then cannot run, which is the failure this exists to stop.
 */
export function dockerPlatform(targetArch: string): string | null {
  return PLATFORM_BY_RID[targetArch] ?? null
}
