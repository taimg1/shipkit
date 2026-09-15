/**
 * Reading the parts of Kamal's config/deploy.yml that the kit has to agree with.
 *
 * Pure, so it can be tested without Dagger. The kit connects to the server itself for backup,
 * migrate and history, and Kamal connects separately for release and rollback. If the two
 * disagree about the user or port, backups run as one user and releases as another — or one of
 * them cannot connect at all, half-way through a deploy (#15).
 */

export interface KamalSsh {
  /** Kamal's default when the file does not say. */
  user: string
  port: number
}

/**
 * `ssh.user` and `ssh.port` from deploy.yml, with Kamal's own defaults (root, 22).
 *
 * Read line by line inside the top-level `ssh:` block rather than with a YAML parser: the block
 * is flat, and anything indented under another key must not be mistaken for it.
 */
export function parseKamalSsh(deployYml: string): KamalSsh {
  const result: KamalSsh = { user: "root", port: 22 }
  let inSsh = false

  for (const raw of deployYml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "")
    if (/^\S/.test(line)) {
      inSsh = /^ssh:\s*$/.test(line)
      continue
    }
    if (!inSsh) continue
    const m = /^\s+(user|port):\s*["']?([^"'\s]+)["']?\s*$/.exec(line)
    if (!m) continue
    if (m[1] === "user") result.user = m[2]
    else result.port = Number(m[2])
  }
  return result
}

/**
 * The doctor line for one environment's SSH settings.
 *
 * MISMATCH fails the check. WARN does not, but says what is wrong: a deploy that logs in as
 * root works on a fresh VPS and stops working the day the server is hardened, which is the
 * wrong day to find out.
 */
export function checkSsh(envName: string, env: { sshUser: string; sshPort: number }, kamal: KamalSsh | null): string {
  if (kamal && (kamal.user !== env.sshUser || kamal.port !== env.sshPort)) {
    return (
      `MISMATCH (shipkit.yaml ${envName}: ${env.sshUser}@:${env.sshPort} vs ` +
      `config/deploy.yml: ${kamal.user}@:${kamal.port})`
    )
  }
  if (env.sshUser === "root") {
    return `WARN ${envName} connects as root; use a deploy user in the docker group (see docs/runbooks/deploy.md)`
  }
  return `ok (${envName}: ${env.sshUser}@:${env.sshPort}${kamal ? ", matches config/deploy.yml" : ""})`
}
