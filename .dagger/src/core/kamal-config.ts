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

/**
 * Every name the project declares as a secret in config/deploy.yml — under `env.secret` and
 * under each accessory's.
 *
 * Kamal resolves these from `.kamal/secrets`, a file of `NAME=value` lines. The kit used to
 * inject only KAMAL_REGISTRY_PASSWORD into the container it runs Kamal in, so every other name
 * resolved to nothing and Kamal carried on with an empty value (#19). PostgreSQL happened to
 * refuse to initialise without a password, which is the only reason that failed loudly; a
 * connection string or an API key would have deployed green and misbehaved in production.
 *
 * Read line by line rather than with a YAML parser, and deliberately without caring which block
 * a name came from: the answer is the set of names that must have values, and a name under an
 * accessory needs one exactly as much as a name under the app.
 */
export function declaredSecrets(deployYml: string): string[] {
  const names = new Set<string>()
  // The indentation of the `secret:` key whose list we are currently inside, or null.
  let listIndent: number | null = null

  for (const raw of deployYml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\s+$/, "")
    if (line.trim().length === 0) continue
    const indent = line.length - line.trimStart().length

    if (listIndent !== null) {
      const item = /^\s*-\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?$/.exec(line)
      if (item && indent > listIndent) {
        names.add(item[1])
        continue
      }
      // Anything else ends the list, including a sibling key at the same indentation.
      listIndent = null
    }

    if (/^\s*secret:\s*$/.test(line)) listIndent = indent
  }

  return [...names]
}

/**
 * The declared names that the resolved secrets file does not actually provide.
 *
 * The wrapper resolves references before the deploy starts, so this should normally be empty —
 * it is the second lock on the same door. A project can also edit `.kamal/secrets` by hand, or
 * declare something in deploy.yml and forget to list it, and neither of those should be found
 * out by a container that has already booted.
 */
export function missingSecrets(declared: readonly string[], secretsFile: string): string[] {
  const provided = new Map<string, string>()
  for (const raw of secretsFile.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.replace(/\s+$/, ""))
    if (m) provided.set(m[1], m[2].trim())
  }
  return declared.filter((name) => {
    const value = provided.get(name)
    // An unresolved reference counts as absent: it is a name, not a value.
    return value === undefined || value === "" || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)
  })
}
