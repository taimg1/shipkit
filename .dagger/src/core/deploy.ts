import { notImplemented } from "../errors.js"

/**
 * The deploy stages land in M6 (docs/v1-plan.md). Each one throws rather than returning a
 * neutral result, so that a half-built deploy can never look like a successful one.
 *
 * The order and the gates are already fixed by ADR 0004:
 *   backup -> migrate -> release -> verify -> rollback -> clean
 *
 * Contracts, so M6 is assembly and not design:
 *
 *  backup()   pg_dump -Fc, then size > threshold AND `pg_restore --list` succeeds AND a
 *             restore into a scratch service yields table count > 0 (D7). Returns the
 *             bucket path, which is the gate token: migrate() refuses to run without one.
 *
 *  migrate()  reads the last applied id from production __EFMigrationsHistory (D5), builds
 *             the bundle for HEAD, runs it. On failure the pipeline stops and the OLD image
 *             is still serving — nothing has been released yet.
 *
 *  release()  kamal deploy --version sha-<short>. The core passes --version; it does not
 *             edit config/deploy.yml.
 *
 *  verify()   GET <url><health> with retries; passes only when the reported version equals
 *             the SHA just deployed. A 200 from the previous container is a failure.
 *
 *  rollback() kamal rollback <previous sha>. The database is NOT rolled back — roll forward
 *             (ADR 0005). The run ends red with the backup path printed.
 */

export const backup = () => {
  throw notImplemented("backup", "M6")
}
export const migrate = () => {
  throw notImplemented("migrate", "M6")
}
export const release = () => {
  throw notImplemented("release", "M6")
}
export const verify = () => {
  throw notImplemented("verify", "M6")
}
export const rollback = () => {
  throw notImplemented("rollback", "M6")
}
