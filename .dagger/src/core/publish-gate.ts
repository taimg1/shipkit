/**
 * Whether `ci` may publish the image it built, and under which tag.
 *
 * The registry is what `deploy` and `rollback` read, by tag, so anything that reaches it can be
 * deployed. Every way this used to let an image in by default is closed here:
 *
 *  - no `--branch` meant "publish" (`dagger call ci` called directly, or a wrapper outside git).
 *    Not knowing which branch this is, is not the same as knowing it is the default one.
 *  - `--sha` defaulted to "dev", so the image went out as `sha-dev`: a tag that names no commit
 *    and that every such run overwrote — `latest` under another name.
 *
 * Pure, and free of runtime imports, so it can be tested without Dagger. Turning a refusal into
 * a ShipkitError is the caller's job for the same reason.
 */

/** A full git commit SHA. Anything shorter can collide; anything else is not a commit. */
export function isCommitSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha)
}

/**
 * The image tag for a commit: the full SHA, never a prefix.
 *
 * Seven characters were enough to read and not enough to be unique — on a large repository two
 * commits share a prefix, and the second push silently replaces the first under the tag deploy
 * and rollback both select by. Older `sha-<7>` tags stay valid everywhere a tag is read.
 */
export function imageTag(sha: string, dirty = false): string {
  return `sha-${sha}${dirty ? "-dirty" : ""}`
}

export type PublishDecision =
  | { action: "push" }
  /** A normal end for this run: not the default branch, nothing to publish, publishing off. */
  | { action: "skip"; reason: string }
  /** This run was going to publish and must not: a gate, so the run is red. */
  | { action: "refuse"; reason: string; next: string }

export interface PublishInput {
  publish: boolean
  defaultBranch: string
  branch: string | undefined
  sha: string
  dirty: boolean
  /** Whether this run built an image at all. `push` alone has nothing to upload. */
  built: boolean
}

export function publishDecision(p: PublishInput): PublishDecision {
  if (!p.publish) return { action: "skip", reason: "publish: false in shipkit.yaml" }
  if (p.branch === undefined || p.branch === "") {
    return {
      action: "refuse",
      reason: "refusing to publish: the branch being built is unknown",
      next: `Pass --branch. Only ${p.defaultBranch} publishes, and an unknown branch is not ${p.defaultBranch}.`,
    }
  }
  // Not a gate failure — most runs are branch builds and this is their normal end.
  if (p.branch !== p.defaultBranch) {
    return { action: "skip", reason: `branch "${p.branch}" is not ${p.defaultBranch}` }
  }
  if (!p.built) return { action: "skip", reason: "no image was built in this run" }
  // A refusal, not a skip: this run was supposed to publish, and what it would publish is not
  // the commit it is labelled with.
  if (p.dirty) {
    return {
      action: "refuse",
      reason: "refusing to publish an image built from uncommitted changes",
      next: "Commit the changes and run ci again; the registry must only hold images of real commits.",
    }
  }
  if (!isCommitSha(p.sha)) {
    return {
      action: "refuse",
      reason: `refusing to publish: "${p.sha}" is not a full commit SHA`,
      next: "Pass --sha=$(git rev-parse HEAD). The tag must name one commit and never be reused.",
    }
  }
  return { action: "push" }
}

/** The digest out of the address `publish()` returns: `<registry>:<tag>@sha256:<hex>`. */
export function publishedDigest(address: string): string | null {
  return /@(sha256:[0-9a-f]{64})$/.exec(address)?.[1] ?? null
}
