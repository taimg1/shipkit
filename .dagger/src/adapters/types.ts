import { Container, Directory, File, Service } from "@dagger.io/dagger"
import { Config, StackName } from "../config.js"

/**
 * The seam between the universal core and one stack (ADR 0008).
 *
 * The core calls this interface and never branches on `name` after choosing an adapter.
 * Everything here varies by language or ORM; everything in core/ does not.
 *
 * Settled by a second implementation: adapters/next.ts, with the .NET one still passing
 * (docs/multi-stack-plan.md §7, ADR 0008). What the second one changed is recorded there —
 * in short, what a stack needs from shipkit.yaml is part of the seam too, and it lives in
 * adapters/requirements.ts because the core validates config before choosing an adapter.
 */
export interface TestSummary {
  passed: number
  failed: number
  skipped: number
  total: number
}

export interface StackAdapter {
  readonly name: StackName

  /** Dependencies restored with a cache mount; ready for lint and test. */
  restore(src: Directory, cfg: Config): Container

  /**
   * Must fail the container on formatting drift, analyzer errors or type errors.
   *
   * Which tool that is can be the project's choice rather than the stack's (`lint` in
   * shipkit.yaml, docs/multi-stack-plan.md §6); the adapter reads it and never guesses.
   */
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
   *
   * "The runner found no tests" is a summary of zeros, not null. Null is for output that
   * carried no counts at all. Both fail closed, and the first one can say what happened —
   * vitest exits 0 on a file that contains no test, so the distinction is not academic.
   */
  parseTestSummary(raw: string): TestSummary | null

  /**
   * Prepares the browsers image named by `e2e.image` so the project's own e2e command can run
   * in it. The core pulls that image, starts the built application and the declared services,
   * and binds them; installing the project's dependencies inside it is the stack-specific part
   * — `npm ci` for Node, something else for anything else — so it lives here.
   *
   * Absent when the stack has no e2e stage. The core then REFUSES a configured `e2e:` rather
   * than skipping it: a block in shipkit.yaml that quietly does nothing is a gate the project
   * believes it has (ADR 0004).
   */
  e2e?(browsers: Container, src: Directory, cfg: Config): Container

  /**
   * Reads the e2e runner's own counts, for the same reason as parseTestSummary: a suite that
   * discovered nothing exits 0, and the core can only refuse that if the run reports counts.
   *
   * Separate from parseTestSummary because it is a different runner — vitest and Playwright
   * do not print the same summary — and a stack may have one and not the other.
   */
  parseE2eSummary?(raw: string): TestSummary | null

  /**
   * Absent when the stack has no migrations to apply.
   *
   * The core skips the db stage when it is absent, so a stack without one may not be
   * configured with a database at all — that refusal is in adapters/requirements.ts, because
   * a skipped gate must not be how the kit answers "no adapter for this".
   */
  db?: DbAdapter
}

export interface DbAdapter {
  /**
   * e.g. "__EFMigrationsHistory", "_prisma_migrations". The core never hardcodes this.
   *
   * Reading it is the core's job, not the adapter's: production is behind SSH on a network
   * the adapter has no business knowing about. The adapter says what the table is called;
   * the core decides how to reach it.
   */
  readonly historyTable: string
  /**
   * Names the id column can have, in order of preference. More than one because naming
   * conventions rename it (`MigrationId` vs `migration_id`); the core reads which one the
   * production table actually has rather than assuming (#12).
   */
  readonly historyIdColumns: readonly string[]

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
