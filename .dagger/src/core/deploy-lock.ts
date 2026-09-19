/**
 * The deploy lock — pure, so the scripts can be run and tested against a local directory.
 *
 * Kamal takes its own lock, but only inside `kamal deploy`/`rollback`/`prune`: after the backup
 * and after the migrations. Two deploys started together both passed the token check, both
 * backed up, both migrated, and then released in whatever order they finished — older code on
 * a newer schema, or a backup taken before the other run's migration (B13/C8).
 *
 * So the kit takes a lock of its own on the server, from before anything changes until after
 * verify (and the rollback, if verify failed). `mkdir` is the lock: it is atomic, and it either
 * creates the directory or fails because someone else did. It lives under ~/.shipkit rather than
 * ~/.kamal, so it can never be mistaken for, or released as, Kamal's own lock.
 *
 * A lock that is already held is a refusal, never a wait: whoever holds it may be mid-migration,
 * and the person running this needs to know who that is rather than queue behind them.
 */

/** Where the lock lives on the server, relative to the SSH user's home. */
export function lockDir(service: string): string {
  const name = /^[A-Za-z0-9._-]+$/.test(service) ? service : "app"
  return `$HOME/.shipkit/deploy-lock-${name}`
}

export interface LockHolder {
  /** Random per run. Release only removes a lock carrying this id — never someone else's. */
  id: string
  sha: string
  env: string
  /** Who started the run, as the wrapper knows it. */
  actor: string
}

/** Values written into the script. Restricted so nothing in them can be read as shell. */
const safe = (v: string) => v.replace(/[^A-Za-z0-9@._:+/-]/g, "_").slice(0, 120)

/**
 * Acquires the lock. Prints `ACQUIRED`, or `HELD` followed by the holder's details. Anything
 * else — including nothing — is a failure to acquire (parseLockAcquire).
 */
export function lockAcquireScript(service: string, h: LockHolder): string {
  const dir = lockDir(service)
  return [
    `mkdir -p "$HOME/.shipkit"`,
    `if mkdir "${dir}" 2>/dev/null; then`,
    `  printf 'id=%s\\nsha=%s\\nenv=%s\\nactor=%s\\nserver_user=%s\\nsince=%s\\n' ` +
      `'${safe(h.id)}' '${safe(h.sha)}' '${safe(h.env)}' '${safe(h.actor)}' "$(id -un)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ` +
      `> "${dir}/holder" || { rm -rf "${dir}"; exit 1; }`,
    `  echo ACQUIRED`,
    `else`,
    `  echo HELD`,
    `  cat "${dir}/holder" 2>/dev/null || echo "holder=unknown (no holder file)"`,
    `fi`,
  ].join("\n")
}

/**
 * Releases the lock if, and only if, it is still ours. Prints `RELEASED` or `NOT-OURS`.
 * A lock someone removed by hand and someone else re-took must survive this run finishing.
 */
export function lockReleaseScript(service: string, id: string): string {
  const dir = lockDir(service)
  return [
    `if grep -qx 'id=${safe(id)}' "${dir}/holder" 2>/dev/null; then`,
    `  rm -rf "${dir}" && echo RELEASED`,
    `else`,
    `  echo NOT-OURS`,
    `fi`,
  ].join("\n")
}

/** The manual unlock, as the refusal and the runbook print it. */
export function unlockCommand(service: string): string {
  return `rm -rf ${lockDir(service).replace("$HOME", "~")}`
}

export type LockAcquire =
  | { ok: true }
  | { ok: false; held: true; holder: string }
  | { ok: false; held: false; reason: string }

export function parseLockAcquire(out: string): LockAcquire {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines[0] === "ACQUIRED" && lines.length === 1) return { ok: true }
  if (lines[0] === "HELD") {
    const holder = lines
      .slice(1)
      .filter((l) => !l.startsWith("id="))
      .join(", ")
    return { ok: false, held: true, holder: holder || "unknown" }
  }
  // Silence, or an answer the kit cannot read, is not "no one holds it".
  return { ok: false, held: false, reason: out.trim().slice(0, 200) || "no answer" }
}
