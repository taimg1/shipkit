import { Container, Directory, File, Service } from "@dagger.io/dagger"
import { Config } from "../config.js"

/**
 * The seam between the universal core and one stack (ADR 0008).
 *
 * The core calls this interface and never branches on `name` after choosing an adapter.
 * Everything here varies by language or ORM; everything in core/ does not.
 *
 * NOTE: this interface is a guess made with one implementation. It becomes settled when a
 * second adapter exists and the first still passes — see docs/multi-stack-plan.md §7 step 3.
 */
export interface StackAdapter {
  readonly name: string

  /** Dependencies restored with a cache mount; ready for lint and test. */
  restore(src: Directory, cfg: Config): Container

  /** Must fail the container on formatting drift or analyzer errors. */
  lint(c: Container, cfg: Config): Container

  /**
   * Runs unit + integration tests. `postgres` is started by the core and bound here —
   * the adapter never starts its own database.
   */
  test(c: Container, cfg: Config, services: { postgres?: Service }): Container

  /** Absent when `db: none`. */
  db?: DbAdapter
}

export interface DbAdapter {
  /** e.g. "__EFMigrationsHistory", "_prisma_migrations". The core never hardcodes this. */
  readonly historyTable: string

  /** Last applied migration id in a live database, or null if none. */
  lastApplied(dsn: string, cfg: Config, src: Directory): Promise<string | null>

  /**
   * Plain, NON-idempotent SQL for everything after `from`. This is what Squawk lints;
   * it must not be wrapped in DO $$ blocks, which Squawk may not analyse — the false-green
   * risk in ci-cd-plan.md §7.2.
   */
  pendingSql(src: Directory, cfg: Config, from: string | null): File

  /** The artifact that actually applies migrations in production. */
  applyArtifact(src: Directory, cfg: Config): Container

  /** Ids of migrations after `from`, for display in the deploy plan. */
  pendingList(src: Directory, cfg: Config, from: string | null): Promise<string[]>
}
