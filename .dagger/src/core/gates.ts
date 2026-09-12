import { Finding } from "../report.js"
import { EXIT, ShipkitError } from "../errors.js"

/**
 * The four gates of ADR 0004 all fail closed. A gate that logs a warning and continues is
 * worse than no gate — it manufactures the appearance of safety. Every helper here throws.
 */

export class GateFailure extends ShipkitError {
  constructor(
    readonly gate: string,
    message: string,
    next?: string,
    readonly findings?: Finding[],
  ) {
    super(EXIT.GATE, message, next)
    this.name = "GateFailure"
  }
}

/** Gate 1 — a dangerous migration never reaches main. */
export const squawkFailed = (findings: Finding[]) =>
  new GateFailure(
    "squawk",
    `Squawk reported ${findings.length} violation(s)`,
    "Fix the migration. For indexes use CREATE INDEX CONCURRENTLY via " +
      "migrationBuilder.Sql(..., suppressTransaction: true) — see docs/adr/0005.",
    findings,
  )

/** Gate 1b — the crude backstop for the EF rename trap (ci-cd-plan.md §7.3). */
export const destructiveSql = (findings: Finding[]) =>
  new GateFailure(
    "destructive-sql",
    `migration contains ${findings.length} destructive statement(s) without an intent marker`,
    'If this is intentional, emit migrationBuilder.Sql("-- shipkit:destructive-ok <reason>") ' +
      "in the same migration. If it is a renamed property, use RenameColumn instead — EF " +
      "generates DROP + ADD and the data is silently lost.",
    findings,
  )

/** Gate 1c — the seeded schema copy lost data while CI stayed green. */
export const dataLoss = (detail: string) =>
  new GateFailure(
    "apply-to-copy",
    `applying the migration to a seeded copy lost data: ${detail}`,
    "This is the rename trap. Use RenameColumn, or split the change across releases " +
      "(expand/contract) — see docs/adr/0005.",
  )

/** Gate 3 — tests ran and some failed. The counts travel with the failure. */
export const testsFailed = (s: { passed: number; failed: number; total: number }) =>
  new GateFailure(
    "test",
    `${s.failed} of ${s.total} test(s) failed`,
    "The failing test names are in the stage output above.",
  )

/**
 * Gate 3 — the test run discovered nothing.
 *
 * A runner that finds no tests exits 0. Without this the `test` stage would report a pass
 * for a project whose test discovery is broken — green CI, nothing verified.
 */
export const noTestsRan = (detail: string) =>
  new GateFailure(
    "test",
    `the test run reported no tests (${detail})`,
    "Check test discovery: a runner that finds nothing still exits 0, so this is treated " +
      "as a failure rather than a pass.",
  )

/**
 * Gate 1d — the migration list and the generated SQL disagree.
 *
 * Almost always a stale assembly: `dotnet ef migrations add` does not rebuild, so `--no-build`
 * generates a script from an assembly that does not contain the new migration. The result is
 * an empty script that every other gate happily passes.
 */
export const emptyScript = (pending: string[]) =>
  new GateFailure(
    "empty-script",
    `${pending.length} migration(s) pending but the generated SQL contains no schema change`,
    "The compiled assembly is probably stale — build before generating the script. " +
      "Failing closed: an empty script would pass every downstream gate without inspecting anything.",
    pending.map((id) => ({ rule: "pending-not-in-script", message: id })),
  )

/** Gate 2 — no verified backup, no migration. */
export const backupUnverified = (reason: string) =>
  new GateFailure(
    "backup",
    `backup is not verified: ${reason}`,
    "The migration will not run without a restorable dump. Check the backup job and bucket.",
  )

/** Gate 4 — the deployed SHA is not the one answering. */
export const verifyFailed = (expected: string, got: string | null) =>
  new GateFailure(
    "verify",
    `health check reports version "${got ?? "none"}", expected "${expected}"`,
    "A 200 from the previous container is a failed deploy that looks green. Rolling back.",
  )
