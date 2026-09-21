/**
 * The deploy plan and its token — pure, so the rule that decides whether a confirmation is
 * still valid can be tested without a server.
 *
 * This file must not import Dagger. Building a plan needs production; deciding whether a
 * plan still matches does not, and keeping them apart is what makes the second testable.
 */

import { createHash } from "node:crypto"

export interface DeployPlan {
  env: string
  url: string
  imageTag: string
  /** What Kamal reports as deployed. Derived from the `latest` tag, so it can drift. */
  currentImageTag: string | null
  /**
   * What the running application actually reports from /health.
   *
   * Kept alongside the tag because they can disagree: Kamal derives the current version from
   * the `latest` tag, and anything that moves that tag out of band — a manual rollback, a
   * hand-run `docker tag` — leaves it describing something that is not serving. The rollback
   * target comes from the tag, so a silent disagreement there sends a rollback to the wrong
   * image at the worst moment.
   */
  servingVersion: string | null
  /**
   * What the deploy does to the server before it can deploy — e.g. booting the database on a
   * first deploy. Part of the token: provisioning production is a change, confirmed like one.
   */
  provision: string[]
  migrations: string[]
  sqlDigest: string
  sqlPreview: string
  destructive: boolean
  /**
   * What an allow-loss marker in the pending SQL says may be destroyed (core/sql-scan.ts).
   *
   * Carried on the plan rather than re-derived by whoever needs it: a waiver is part of what a
   * confirmation is about, and a second scan of the same SQL somewhere else is a second
   * implementation of the rule that decides whether a client loses a column.
   */
  allowLoss: string[]
  /**
   * The digest the registry serves for `imageTag`, or null when nothing answers for it —
   * including when the project publishes no image at all.
   *
   * Part of the token because a tag can be pushed again: without it, a plan confirmed for
   * `sha-abc` would still execute after `sha-abc` had become a different image.
   */
  imageDigest: string | null
  lastVerifiedBackup: string | null
  /**
   * The deploy stages this plan was shown for, in order; null (or absent) means all of them.
   * Part of the token: a plan confirmed for the whole deploy does not authorise running only
   * part of it (B7).
   */
  stages?: string[] | null
  /** Hash of everything above. `--yes` must present this exact token. */
  token: string
}

/**
 * The token proves "this exact plan was displayed" — not "a human approved it".
 * Human approval is a rule on top (docs/cli-design.md), carried in CLAUDE.md and the skill.
 *
 * Hashing the plan's content rather than the commit SHA means the token also stops
 * matching when the current production image, the pending migration list, or the SQL
 * changes between showing the plan and executing it.
 */
export function planToken(p: Omit<DeployPlan, "token">): string {
  const canonical = JSON.stringify({
    env: p.env,
    url: p.url,
    imageTag: p.imageTag,
    currentImageTag: p.currentImageTag,
    provision: p.provision,
    migrations: p.migrations,
    sqlDigest: p.sqlDigest,
    allowLoss: p.allowLoss ?? [],
    imageDigest: p.imageDigest ?? null,
    stages: p.stages ?? "all",
  })
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12)
}

export const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)

export function renderPlan(p: DeployPlan): string {
  const drift =
    p.currentImageTag && p.servingVersion && !p.servingVersion.startsWith(p.currentImageTag.replace(/^sha-/, ""))
      ? `\n  WARNING     Kamal reports ${p.currentImageTag} but /health reports ${p.servingVersion}.` +
        `\n              A rollback would target the tag. Check the server before deploying.`
      : ""

  const lines = [
    `  target      ${p.env}  (${p.url})`,
    `  image       ${p.imageTag}${p.currentImageTag ? `  <-  currently ${p.currentImageTag}` : "  (first deploy to this server)"}${drift}`,
    ...(p.provision.length > 0 ? [`  server      ${p.provision.join("\n              ")}`] : []),
    `  migrations  ${p.migrations.length > 0 ? p.migrations.join("\n              ") : "none"}`,
    `  sql         ${p.sqlPreview}`,
    `  backup      will run first; last verified ${p.lastVerifiedBackup ?? "never"}`,
    ...(p.stages ? [`  stages      ${p.stages.join(", ")} only`] : []),
    "",
    `  to execute: shipkit deploy --yes=${p.token}${p.stages ? ` --stage=${p.stages.join(",")}` : ""}`,
  ]
  return lines.join("\n")
}
