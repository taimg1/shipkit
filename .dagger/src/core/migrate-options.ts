/**
 * The timeouts the migration bundle's connection runs under — pure, so the values and the
 * shell they end up in can be tested without a server.
 *
 * EF sets neither `lock_timeout` nor `statement_timeout`, so Squawk's two rules for them fire
 * on every migration and are excluded in squawk.default.toml. That exclusion is only honest
 * because the protection is applied here instead, to the connection the bundle opens (B5).
 * Without it an ALTER TABLE queued behind a long transaction waits for its ACCESS EXCLUSIVE
 * lock indefinitely, and every query on that table queues behind it: an outage with no end.
 */

export interface MigrationTimeouts {
  lockTimeout: string
  statementTimeout: string
}

/**
 * Defaults, written into shipkit.example.yaml so a reader sees them.
 *
 * lock_timeout is short: a migration that cannot get its lock within seconds is blocking
 * traffic while it waits, and failing is the better outcome — nothing is applied, run it again
 * when the long transaction is gone. statement_timeout is long: it is there to stop a runaway,
 * not to race a legitimate CREATE INDEX CONCURRENTLY on a large table.
 */
export const DEFAULT_MIGRATION_TIMEOUTS: MigrationTimeouts = {
  lockTimeout: "5s",
  statementTimeout: "15min",
}

/**
 * A PostgreSQL duration with an explicit unit, and never zero.
 *
 * The unit is required because PostgreSQL reads a bare number as milliseconds, and `5` meaning
 * five milliseconds is not what anyone writing it meant. Zero is refused because in PostgreSQL
 * it means "no timeout" — a setting that switches the protection off is not a value for it.
 * Validated this strictly for a second reason: the value is written into a shell command.
 */
export function pgDuration(value: unknown): string | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  return /^[1-9][0-9]{0,6}(ms|s|min|h|d)$/.test(v) ? v : null
}

/** The server options the bundle connects with, as libpq/Npgsql read them from PGOPTIONS. */
export function pgOptions(t: MigrationTimeouts): string {
  return `-c lock_timeout=${t.lockTimeout} -c statement_timeout=${t.statementTimeout}`
}

/**
 * A shell fragment that refuses a connection string carrying its own `Options`.
 *
 * Npgsql reads PGOPTIONS only when the connection string has no Options keyword; with one, the
 * timeouts above would be dropped without a word and the migration would run unprotected.
 * Checked in the shell because the connection string is a Secret — it never reaches this code.
 */
export function refuseOwnOptions(variable: string): string {
  return (
    `if printf '%s' "$${variable}" | grep -Eiq '(^|;)[[:space:]]*options[[:space:]]*='; then ` +
    `echo "the production connection string sets Options=, which would override the migration's ` +
    `lock_timeout and statement_timeout; remove it and set the timeouts in shipkit.yaml (migrations:)" >&2; ` +
    `exit 1; fi`
  )
}
