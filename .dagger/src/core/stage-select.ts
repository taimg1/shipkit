/**
 * Which stages of a run actually execute.
 *
 * `ci` used to take one stage name and compare it with `===`. That was enough while the whole
 * pipeline ran as a single CI job, and stopped being enough the moment the jobs were split so
 * a reader could see them: `build` produces the container that `push` uploads, and the two
 * share it in memory. Split across two runners, `push` finds no image and skips itself with
 * "no image was built in this run" — a green run that published nothing.
 *
 * So a selection is a set, not a name, and `--stage=build,push` is how those two stay together
 * while the rest of the pipeline moves to its own job.
 *
 * An unrecognised name is refused, never ignored. `--stage=tests` — the job is called "tests",
 * the stage is called "test" — would otherwise match no stage, run nothing, and exit 0. A
 * pipeline that silently does nothing is the worst possible green.
 *
 * Pure, and deliberately free of runtime imports, so it can be tested without Dagger. Turning
 * `unknown` into a ShipkitError is the caller's job for the same reason.
 */

export interface StageSelection {
  /** The stages to run, or null for all of them. Meaningless while `unknown` is non-empty. */
  selected: Set<string> | null
  /** Names that are not stages of this command. Non-empty means the caller must refuse. */
  unknown: string[]
}

/**
 * Parses `--stage`: absent means every stage, otherwise a comma-separated subset.
 *
 * An empty spec (`--stage=`) yields one unknown name, `""`, rather than quietly meaning
 * "all" or "none" — both of those are answers to a question the caller did not ask.
 */
export function parseStages(spec: string | undefined, known: string[]): StageSelection {
  if (spec === undefined) return { selected: null, unknown: [] }

  const names = spec.split(",").map((n) => n.trim())
  const unknown = names.filter((n) => !known.includes(n))
  if (unknown.length > 0) return { selected: new Set(), unknown }

  return { selected: new Set(names), unknown: [] }
}

/** Whether a stage runs under this selection. */
export function stageRuns(selection: StageSelection, name: string): boolean {
  return selection.selected === null || selection.selected.has(name)
}

/**
 * The stages a selection runs, in pipeline order — or null when that is every stage.
 *
 * This is what a plan token confirms (B7). `--stage=` naming every stage is the same run as no
 * `--stage` at all, so both yield null and both match the same token.
 */
export function selectedStages(selection: StageSelection, known: string[]): string[] | null {
  if (selection.selected === null) return null
  const list = known.filter((n) => selection.selected!.has(n))
  return list.length === known.length ? null : list
}

/**
 * Why a deploy stage set is unsafe to run, or null when it is not.
 *
 * A valid token used to authorise any subset of the plan: `--stage=release` shipped new code
 * onto the old schema with the migrations still pending, and `--stage=release,clean` released
 * with no verify, so no health gate and no automatic rollback (B7). The token now names the
 * stages too, and these combinations are refused whatever the token says — a plan cannot
 * confirm skipping a gate.
 */
export function deployStageProblem(selection: StageSelection, pendingMigrations: number): string | null {
  const runs = (name: string) => stageRuns(selection, name)
  if (runs("release") && !runs("verify")) {
    return "release without verify: nothing would check the new version answers, and nothing would roll it back"
  }
  if (runs("release") && !runs("migrate") && pendingMigrations > 0) {
    return `release without migrate while ${pendingMigrations} migration(s) are pending: the new code would run on the old schema`
  }
  if (runs("migrate") && !runs("backup") && pendingMigrations > 0) {
    return "migrate without backup: no migration runs without a verified backup taken in the same deploy"
  }
  return null
}

/**
 * Deploy selections that name real stages and still cannot mean anything (D-06). Both used to
 * be accepted: `--stage=rollback` asked for a plan token and then ran nothing, and provisioning
 * ran whenever the plan had it, whatever was selected.
 *
 * Called before the plan exists (no provisioning known yet) and again once it does.
 */
export function deploySelectionProblem(
  selection: StageSelection,
  plannedProvision: readonly string[],
): { message: string; next: string } | null {
  if (selection.selected?.has("rollback")) {
    return {
      message: "rollback cannot be selected as a deploy stage",
      next:
        "A deploy rolls back on its own when verify fails. To put a previous version back by " +
        "hand: `shipkit rollback sha-<previous>` (docs/runbooks/rollback.md).",
    }
  }
  if (plannedProvision.length > 0 && !stageRuns(selection, "provision")) {
    return {
      message: `the plan provisions the server first (${plannedProvision.join("; ")}) and --stage leaves provision out`,
      next: "Add provision to --stage, or deploy without --stage.",
    }
  }
  return null
}
