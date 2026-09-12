import { createHash } from "node:crypto"

export interface DeployPlan {
  env: string
  url: string
  imageTag: string
  currentImageTag: string | null
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
  const lines = [
    `  target      ${p.env}  (${p.url})`,
    `  image       ${p.imageTag}${p.currentImageTag ? `  <-  currently ${p.currentImageTag}` : ""}`,
    `  migrations  ${p.migrations.length > 0 ? p.migrations.join("\n              ") : "none"}`,
    `  sql         ${p.sqlPreview}`,
    `  backup      will run first; last verified ${p.lastVerifiedBackup ?? "never"}`,
    "",
    `  to execute: shipkit deploy --yes=${p.token}`,
  ]
  return lines.join("\n")
}
