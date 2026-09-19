import { createHash, createHmac } from "node:crypto"

/**
 * The deploy host's public key, pinned in shipkit.yaml as `hostKey` — known_hosts lines.
 *
 * Pure, so the parsing and matching can be tested without a server, and free of runtime
 * imports so the tests can load it directly.
 *
 * Every SSH connection the pipeline makes starts from a fresh container. Before this existed
 * each of them trusted whatever key the first packet presented (`accept-new` against an empty
 * known_hosts), so "a changed key is refused" was never true: anything between the runner and
 * the server could answer instead, and would have been handed a docker-group session, a
 * production dump and the database password. The key the client authenticates with proves
 * who the client is; only this proves who the server is.
 */

/** What the kit accepts. DSA is long dead; the rest are what `ssh-keyscan` returns by default. */
export const HOST_KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
] as const

export interface KnownHostsEntry {
  /** The host field as written: comma-separated names or patterns, or one hashed `|1|` name. */
  hosts: string
  type: string
  /** base64 of the key blob. */
  key: string
}

/** How to get the value, for every message that says it is missing or wrong. */
export function hostKeyHint(host: string, port: number): string {
  const portFlag = port === 22 ? "" : `-p ${port} `
  return (
    `Run \`ssh-keyscan -t ed25519 ${portFlag}${host}\` and paste the line into shipkit.yaml as ` +
    `hostKey. Before committing it, compare its fingerprint (\`ssh-keygen -lf <file>\`) with the ` +
    `one server/bootstrap.sh printed ON the server — a keyscan over the network is exactly what ` +
    `a man in the middle would answer. See docs/runbooks/server-bootstrap.md.`
  )
}

/**
 * Parses known_hosts text. Throws with a message naming the offending line; never skips one,
 * because a line quietly dropped here is a host that quietly stops being verified.
 */
export function parseKnownHosts(text: string): KnownHostsEntry[] {
  const entries: KnownHostsEntry[] = []
  const lines = text.split(/\r?\n/)

  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) return
    const where = `hostKey line ${i + 1}`

    if (line.startsWith("@")) {
      // @cert-authority and @revoked change what a line means. Neither belongs in a pin.
      throw new Error(`${where}: markers such as ${line.split(/\s+/)[0]} are not supported`)
    }
    const fields = line.split(/\s+/)
    if (fields.length < 3) {
      throw new Error(`${where} is not a known_hosts line; expected "<host> <key type> <base64 key>"`)
    }
    const [hosts, type, key] = fields
    if (!(HOST_KEY_TYPES as readonly string[]).includes(type)) {
      throw new Error(`${where}: key type "${type}" is not one of ${HOST_KEY_TYPES.join(", ")}`)
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
      throw new Error(`${where}: the key is not base64`)
    }
    // The blob names its own type. A line whose label and blob disagree was pasted together
    // from two places, and would never match what the server presents.
    const blob = Buffer.from(key, "base64")
    const len = blob.length >= 4 ? blob.readUInt32BE(0) : -1
    const inner = len > 0 && 4 + len <= blob.length ? blob.subarray(4, 4 + len).toString("latin1") : null
    if (inner !== type) {
      throw new Error(`${where}: the key data is not a ${type} key${inner ? ` (it is ${inner})` : ""}`)
    }
    if (hosts.startsWith("|") && !/^\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/.test(hosts)) {
      throw new Error(`${where}: malformed hashed host name`)
    }
    entries.push({ hosts, type, key })
  })

  if (entries.length === 0) throw new Error("hostKey contains no known_hosts lines")
  return entries
}

/** The name ssh looks up in known_hosts: bare on port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** Whether an entry's host field covers this host and port — plain, pattern or hashed. */
export function entryMatches(entry: KnownHostsEntry, host: string, port: number): boolean {
  const name = knownHostsName(host, port)

  if (entry.hosts.startsWith("|1|")) {
    const [, , salt, hash] = entry.hosts.split("|")
    const mac = createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest("base64")
    return mac === hash
  }

  let matched = false
  for (const pattern of entry.hosts.split(",")) {
    const negated = pattern.startsWith("!")
    if (globMatch(negated ? pattern.slice(1) : pattern, name)) {
      if (negated) return false
      matched = true
    }
  }
  return matched
}

function globMatch(pattern: string, name: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${re}$`, "i").test(name)
}

/** `SHA256:…`, the form `ssh-keygen -lf` and the ssh client print. */
export function fingerprint(entry: KnownHostsEntry): string {
  const digest = createHash("sha256").update(Buffer.from(entry.key, "base64")).digest("base64")
  return `SHA256:${digest.replace(/=+$/, "")}`
}

/**
 * The known_hosts file every SSH container gets, or an error saying why there cannot be one.
 *
 * Refuses when no line names this host and port. ssh would refuse too, but with "Host key
 * verification failed" half-way through a deploy, which reads as an attack rather than as a
 * typo in shipkit.yaml.
 */
export function knownHostsFor(env: { host?: string; sshPort: number; hostKey?: string }): string {
  if (!env.host) throw new Error("this environment has no host")
  if (!env.hostKey) throw new Error(`no hostKey is pinned for ${env.host}`)
  const entries = parseKnownHosts(env.hostKey)
  if (!entries.some((e) => entryMatches(e, env.host!, env.sshPort))) {
    throw new Error(
      `hostKey has no line for ${knownHostsName(env.host, env.sshPort)}, which is the name ssh ` +
        `looks up for host "${env.host}" on port ${env.sshPort}`,
    )
  }
  return entries.map((e) => `${e.hosts} ${e.type} ${e.key}`).join("\n") + "\n"
}

/** The doctor line for one environment's pinned host key. */
export function checkHostKey(envName: string, env: { host?: string; sshPort: number; hostKey?: string }): string {
  if (!env.host) return `ok (${envName}: no host yet)`
  try {
    knownHostsFor(env)
  } catch (e) {
    return `MISMATCH (${envName}: ${(e as Error).message})`
  }
  const prints = parseKnownHosts(env.hostKey!)
    .filter((e) => entryMatches(e, env.host!, env.sshPort))
    .map((e) => `${e.type} ${fingerprint(e)}`)
  return `ok (${envName}: ${prints.join(", ")}; compare with server/bootstrap.sh's output)`
}

/**
 * ~/.ssh/config for the Kamal container. Kamal passes no host-key option to net-ssh, and
 * net-ssh's default (`accept_new_or_local_tunnel`) is the same trust-on-first-use this file
 * exists to end; net-ssh does read StrictHostKeyChecking from here and maps `yes` to
 * `verify_host_key: :always`. OpenSSH reads it too, which covers an `ssh.proxy` jump.
 */
export const STRICT_SSH_CONFIG =
  "# Written by shipkit. Host keys come from shipkit.yaml's hostKey; nothing else is trusted.\n" +
  "StrictHostKeyChecking yes\n" +
  "UserKnownHostsFile /root/.ssh/known_hosts\n" +
  "GlobalKnownHostsFile /dev/null\n"
