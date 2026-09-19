/**
 * The run summary: several stage reports rendered as one table.
 *
 * Splitting `ci` into one job per stage buys a reader a pipeline they can see at a glance, and
 * costs them the single report that used to describe the whole run. Each job now produces its
 * own, and this puts them back together for $GITHUB_STEP_SUMMARY.
 *
 * Output formatting, which is the wrapper's job (ADR 0009). No decision is made here — nothing
 * in this file can change what runs, what publishes, or whether a gate passed.
 *
 * Pure, so it is tested without Dagger, without GitHub, and without a pipeline.
 */

/** Pipeline order, so the table reads top to bottom regardless of which job finished first. */
export const CI_STAGE_ORDER = ["pre", "build", "test", "db", "push"]

/**
 * How much an entry for the same stage is worth when several reports mention it.
 *
 * Every report lists every stage: the ones its job did not run are skipped as "not selected".
 * Merging naively would let that placeholder overwrite the job that actually ran the stage,
 * which is how a summary ends up claiming a pipeline did nothing.
 */
function rank(stage) {
  if (stage.status === "failed") return 3
  if (stage.status === "ok") return 2
  return stage.reason === "not selected" ? 0 : 1
}

/** One entry per stage, keeping whichever report actually has something to say about it. */
export function mergeStages(reports) {
  const best = new Map()
  for (const report of reports) {
    for (const stage of report.stages ?? []) {
      const current = best.get(stage.name)
      if (!current || rank(stage) > rank(current)) best.set(stage.name, stage)
    }
  }

  const known = CI_STAGE_ORDER.filter((name) => best.has(name))
  const extra = [...best.keys()].filter((name) => !CI_STAGE_ORDER.includes(name))
  return [...known, ...extra].map((name) => best.get(name))
}

const MARK = { ok: "+", failed: "x", skipped: "-" }

/** The short, scannable "what happened" column. */
function detail(stage) {
  const parts = []
  if (stage.tag) parts.push(`\`${stage.tag}\``)
  if (stage.tests) parts.push(`${stage.tests.passed}/${stage.tests.total} passed`)
  if (Array.isArray(stage.pending) && stage.pending.length) parts.push(`${stage.pending.length} pending`)
  if (stage.base !== undefined) parts.push(`base \`${escapeCell(stage.base)}\``)
  if (stage.published) parts.push(`\`${stage.published}\``)
  if (stage.status !== "ok" && stage.reason) parts.push(escapeCell(stage.reason))
  return parts.join(" · ") || ""
}

/** A table cell cannot contain a raw pipe or newline without breaking the row. */
function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")
}

/** The failing stages, expanded: the command, its output, and any gate findings. */
function failureDetails(stages) {
  const lines = []
  for (const stage of stages.filter((s) => s.status === "failed")) {
    lines.push("", `<details open><summary><code>${stage.name}</code> — ${escapeCell(stage.reason ?? "failed")}</summary>`, "")

    if (stage.command) lines.push("```", `$ ${stage.command}`, "```")

    if (stage.diagnostics) {
      const d = stage.diagnostics
      const codes = Object.entries(d.codes).map(([c, n]) => `${c} ${n}`).join(", ")
      lines.push(`${d.errors} error(s), ${d.warnings} warning(s) in ${d.files.length} file(s) — ${codes}`, "")
      lines.push("| count | file |", "|---:|---|")
      for (const f of d.files.slice(0, 15)) lines.push(`| ${f.count} | \`${f.path}\` |`)
      if (d.files.length > 15) lines.push(`| | … ${d.files.length - 15} more file(s) |`)
      lines.push("")
    }

    if (stage.findings?.length) {
      lines.push("| rule | where | sql |", "|---|---|---|")
      for (const f of stage.findings) {
        const where = f.migration ?? [f.file, f.line].filter(Boolean).join(":")
        lines.push(`| ${escapeCell(f.rule)} | ${escapeCell(where)} | ${f.sql ? `\`${escapeCell(f.sql)}\`` : escapeCell(f.message ?? "")} |`)
      }
      lines.push("")
    }

    if (stage.output?.length) {
      if (stage.omitted) lines.push(`… ${stage.omitted} earlier line(s) not shown`, "")
      lines.push("```", ...stage.output, "```")
    }

    lines.push("</details>")
  }
  return lines
}

/**
 * The jobs that did not succeed, from GitHub's `needs` context (`toJSON(needs)`), in the order
 * they appear there.
 *
 * Reports alone cannot carry the verdict. A job that fails before the pipeline runs — `unit`,
 * which never writes one, or any job whose setup failed — leaves nothing behind, and a verdict
 * built from what was left behind said "ok" on a red run.
 *
 * `null` means results were asked for and could not be read; that is not a pass either.
 */
export function unsuccessfulJobs(jobs) {
  if (jobs === null) return [{ name: "(job results)", result: "unreadable" }]
  if (!jobs || typeof jobs !== "object") return []
  return Object.entries(jobs)
    .map(([name, job]) => ({ name, result: job?.result ?? "unknown" }))
    .filter((job) => job.result === "failure" || job.result === "cancelled" || job.result === "unknown")
}

/**
 * `toJSON(needs)` as written to a file by the workflow. Anything that is not an object of jobs
 * is `null`, which unsuccessfulJobs reports as unreadable rather than as nothing to report.
 */
export function parseJobResults(text) {
  try {
    const jobs = JSON.parse(text)
    return jobs && typeof jobs === "object" && !Array.isArray(jobs) ? jobs : null
  } catch {
    return null
  }
}

function jobLines(bad) {
  if (bad.length === 0) return []
  return ["", `**Jobs that did not succeed:** ${bad.map((j) => `\`${escapeCell(j.name)}\` (${j.result})`).join(", ")}`]
}

/**
 * Markdown for $GITHUB_STEP_SUMMARY.
 *
 * `reports` may be empty — a run can fail before any job writes one — and that is reported as
 * such rather than rendered as an empty, passing table.
 *
 * `jobs` is GitHub's `needs` context. Without it the verdict can only be as good as the reports;
 * with it, a job that failed without writing one fails the verdict too.
 */
export function renderSummary(reports, { title = "CI", jobs } = {}) {
  const bad = unsuccessfulJobs(jobs)
  if (reports.length === 0) {
    return `## ${title}${bad.length ? " — failed" : ""}\n\nNo stage reports were produced. The jobs failed before the pipeline ran.\n` +
      (bad.length ? jobLines(bad).join("\n") + "\n" : "")
  }

  const stages = mergeStages(reports)
  const failed = reports.some((r) => r.ok === false) || bad.length > 0
  const sha = reports.find((r) => r.sha && r.sha !== "dev")?.sha
  const seconds = reports.reduce((total, r) => total + (r.seconds ?? 0), 0)
  const dirty = reports.some((r) => r.dirty)

  const lines = [
    `## ${title} — ${failed ? "failed" : "ok"}`,
    "",
    sha ? `Commit \`${sha.slice(0, 7)}\` · ${Math.round(seconds)}s of stage time` : `${Math.round(seconds)}s of stage time`,
    "",
    "| | stage | time | detail |",
    "|:-:|---|---:|---|",
  ]

  for (const stage of stages) {
    const time = stage.seconds != null ? `${stage.seconds}s` : ""
    lines.push(`| ${MARK[stage.status] ?? "?"} | \`${stage.name}\` | ${time} | ${detail(stage)} |`)
  }

  if (dirty) {
    lines.push("", "> The source had uncommitted changes. Its image is tagged `-dirty` and was not published.")
  }

  lines.push(...jobLines(bad))
  lines.push(...failureDetails(stages))

  const error = reports.find((r) => r.ok === false)
  if (error?.next) lines.push("", `**Next:** ${escapeCell(error.next)}`)

  return lines.join("\n") + "\n"
}
