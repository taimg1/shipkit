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
  migrations: string[]
  sqlDigest: string
  sqlPreview: string
  destructive: boolean
  lastVerifiedBackup: string | null
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
    migrations: p.migrations,
    sqlDigest: p.sqlDigest,
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
    `  image       ${p.imageTag}${p.currentImageTag ? `  <-  currently ${p.currentImageTag}` : ""}${drift}`,
    `  migrations  ${p.migrations.length > 0 ? p.migrations.join("\n              ") : "none"}`,
    `  sql         ${p.sqlPreview}`,
    `  backup      will run first; last verified ${p.lastVerifiedBackup ?? "never"}`,
    "",
    `  to execute: shipkit deploy --yes=${p.token}`,
  ]
  return lines.join("\n")
}
