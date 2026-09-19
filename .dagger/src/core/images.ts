/**
 * Every infrastructure image the kit runs, pinned by digest.
 *
 * A tag is a pointer somebody else can move. `alpine:3.21` today and `alpine:3.21` next month
 * are different images, and the containers built from these receive the deploy key, the
 * registry token and the production connection string. A digest is the content itself: if it
 * changes, it is because a commit here changed it.
 *
 * The tag stays in front of the digest so a reader can see what it is; Docker and Dagger use
 * only the digest when both are given. Digests are of the multi-arch index, so the same pin
 * works on an x86 runner and an arm64 workstation.
 *
 * To move one: `docker buildx imagetools inspect <image>:<tag>` and copy the top-level Digest.
 *
 * Pure, and free of runtime imports, so the pins can be tested without Dagger.
 */

/** SSH, psql and curl for talking to the server. */
export const ALPINE_IMAGE =
  "alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507"

/** Scratch PostgreSQL: the test service, the db gate, the backup restore check. */
export const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995"

/** Node for installing Squawk from npm (see core/db.ts for why not the Squawk image). */
export const SQUAWK_BASE_IMAGE =
  "node:22-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9"

/** The delivery layer. An unpinned delivery tool can change a deploy with nothing here changing. */
export const KAMAL_IMAGE =
  "ghcr.io/basecamp/kamal:v2.12.0@sha256:7b5be276aa17bbe122887f6a1ff12865f4848111989699b9786083be95d98415"

/**
 * The glibc runtime the migration bundle runs in, per .NET version (`stackVersion`).
 *
 * A version with no pin here has no runner, rather than an unpinned one: the bundle runs with
 * the production connection string in its environment.
 */
const RUNTIME_DEPS: Record<string, string> = {
  "8.0": "sha256:ea54f52ec0f924f17c35045b97d859c3d2c6c36fd6219dcb9e7c191067ff82c0",
  "9.0": "sha256:92eda3f0c5172c8b3741233933c86b6393b2402e6bcc507f5c645f5ba682c54c",
  "10.0": "sha256:23257ea51d7c12e0d5aabecaffe24b4eccacff63a2e669ea9408ac29790d4ce1",
}

/** The pinned runtime-deps image for a .NET version, or null when the kit has no pin for it. */
export function runtimeDepsImage(version: string): string | null {
  const digest = Object.hasOwn(RUNTIME_DEPS, version) ? RUNTIME_DEPS[version] : undefined
  return digest ? `mcr.microsoft.com/dotnet/runtime-deps:${version}@${digest}` : null
}

export const RUNTIME_DEPS_VERSIONS = Object.keys(RUNTIME_DEPS)
