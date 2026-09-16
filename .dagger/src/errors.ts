/**
 * Exit codes are part of the public contract — see docs/cli-design.md.
 * The wrapper maps these onto process exit codes, so a caller can tell
 * "the code is bad" from "Docker is not running".
 */
export const EXIT = {
  OK: 0,
  GATE: 1,
  CONFIG: 2,
  INFRA: 3,
  CONFIRM: 4,
  NOT_IMPLEMENTED: 5,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export class ShipkitError extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    /** What the caller should do about it. Surfaced as `next` in the report. */
    public next?: string,
  ) {
    super(message)
    this.name = "ShipkitError"
  }

  /**
   * Fields for the failing stage's report entry. A stage that fails still knows things worth
   * reporting — which base it diffed against, how many migrations it looked at — and without
   * this they were lost with the exception.
   */
  detail?: Record<string, unknown>
}

export const configError = (m: string, next?: string) => new ShipkitError(EXIT.CONFIG, m, next)
export const gateError = (m: string, next?: string) => new ShipkitError(EXIT.GATE, m, next)
export const infraError = (m: string, next?: string) => new ShipkitError(EXIT.INFRA, m, next)

/**
 * A stage that is not built yet must fail closed and be distinguishable from a real
 * failure. It must never return "ok" — that is how a gate silently stops being a gate.
 */
export const notImplemented = (what: string, milestone: string) =>
  new ShipkitError(
    EXIT.NOT_IMPLEMENTED,
    `${what} is not implemented yet (planned for ${milestone})`,
    `See docs/v1-plan.md, milestone ${milestone}.`,
  )
