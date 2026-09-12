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
export interface TestSummary {
  passed: number
  failed: number
  skipped: number
  total: number
}

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

  /**
   * Reads the test runner's own summary out of its output.
   *
   * The core needs the counts, not just the exit code: a run that discovers zero tests
   * exits 0 and would otherwise be reported as a pass. Parsing is stack-specific, so it
   * lives behind the seam; deciding that zero tests is a failure is the core's call.
   */
  parseTestSummary(raw: string): TestSummary | null

  /** Absent when `db: none`. */
  db?: DbAdapter
}

export interface DbAdapter {
  /** e.g. "__EFMigrationsHistory", "_prisma_migrations". The core never hardcodes this. */
  readonly historyTable: string

  /** Last applied migration id in a live database, or null if none. */
  lastApplied(dsn: string, cfg: Config, src: Directory): Promise<string | null>

  /**
   * Plain, NON-idempotent SQL for the migrations in `(from, to]`. `null` means the very
   * beginning and the current head respectively.
   *
   * NON-idempotent matters: `--idempotent` wraps statements in DO $$ blocks that Squawk may
   * not analyse, which would produce a false green (ci-cd-plan.md §7.2).
   *
   * It is a range rather than just "what is pending" because apply-to-copy needs to rebuild
   * the schema as production has it before applying anything on top.
   */
  sqlBetween(src: Directory, cfg: Config, from: string | null, to: string | null): File

  /** The artifact that actually applies migrations in production. */
  applyArtifact(src: Directory, cfg: Config): Container

  /** Ids of migrations after `from`, for display in the deploy plan. */
  pendingList(src: Directory, cfg: Config, from: string | null): Promise<string[]>
}
