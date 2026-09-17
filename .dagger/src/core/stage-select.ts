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
