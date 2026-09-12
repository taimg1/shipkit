import { EXIT, ExitCode, ShipkitError } from "./errors.js"

export type StageStatus = "ok" | "failed" | "skipped"

export interface Finding {
  rule: string
  file?: string
  line?: number
  sql?: string
  message?: string
}

export interface Stage {
  name: string
  status: StageStatus
  seconds?: number
  reason?: string
  gate?: string
  findings?: Finding[]
  [extra: string]: unknown
}

export interface Report {
  command: string
  sha: string
  ok: boolean
  exitCode: ExitCode
  seconds: number
  stages: Stage[]
  next?: string
  error?: string
  [extra: string]: unknown
}

/**
 * Accumulates stage results so that a failure still reports everything that ran before it.
 * A report that only says "failed" costs three round trips to fix; one that says what to do
 * costs one.
 */
export class ReportBuilder {
  private readonly stages: Stage[] = []
  private readonly startedAt = Date.now()
  private extra: Record<string, unknown> = {}

  constructor(
    private readonly command: string,
    private readonly sha: string,
  ) {}

  /** Runs `fn` as a named stage, timing it and recording success or failure. */
  async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now()
    try {
      const result = await fn()
      const entry: Stage = { name, status: "ok", seconds: secondsSince(t0) }
      if (isStageDetail(result)) Object.assign(entry, result.detail)
      this.stages.push(entry)
      return result
    } catch (err) {
      const entry: Stage = { name, status: "failed", seconds: secondsSince(t0) }
      if (err instanceof ShipkitError) {
        entry.gate = err.code === EXIT.GATE ? name : undefined
        entry.reason = err.message
        const findings = (err as { findings?: Finding[] }).findings
        if (findings) entry.findings = findings
      } else {
        entry.reason = err instanceof Error ? err.message : String(err)
      }
      this.stages.push(entry)
      throw err
    }
  }

  skip(name: string, reason: string): void {
    this.stages.push({ name, status: "skipped", reason })
  }

  /** Marks every stage that never ran because an earlier one failed. */
  skipRemaining(names: string[], reason = "previous stage failed"): void {
    const seen = new Set(this.stages.map((s) => s.name))
    for (const n of names) if (!seen.has(n)) this.skip(n, reason)
  }

  set(key: string, value: unknown): void {
    this.extra[key] = value
  }

  success(): Report {
    return {
      command: this.command,
      sha: this.sha,
      ok: true,
      exitCode: EXIT.OK,
      seconds: secondsSince(this.startedAt),
      stages: this.stages,
      ...this.extra,
    }
  }

  failure(err: unknown): Report {
    const known = err instanceof ShipkitError
    return {
      command: this.command,
      sha: this.sha,
      ok: false,
      exitCode: known ? err.code : EXIT.INFRA,
      seconds: secondsSince(this.startedAt),
      stages: this.stages,
      error: err instanceof Error ? err.message : String(err),
      next: known ? err.next : undefined,
      ...this.extra,
    }
  }
}

/** Lets a stage function attach structured detail (test counts, findings) to its entry. */
export interface StageDetail<T> {
  value: T
  detail: Record<string, unknown>
}

const isStageDetail = (v: unknown): v is StageDetail<unknown> =>
  typeof v === "object" && v !== null && "detail" in v && "value" in v

export const withDetail = <T>(value: T, detail: Record<string, unknown>): StageDetail<T> => ({
  value,
  detail,
})

const secondsSince = (t: number) => Math.round((Date.now() - t) / 100) / 10

export const serialize = (r: Report): string => JSON.stringify(r, null, 2)
