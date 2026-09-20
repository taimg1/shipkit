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

/** The deploy's own order (ADR 0004). A deploy report is rendered by this same file. */
export const DEPLOY_STAGE_ORDER = ["provision", "backup", "migrate", "release", "verify", "rollback", "clean"]

/** The module's exit code for "this needs a person": a stop, not a failure. */
const CONFIRM = 4

/** Which pipeline these reports came from. `deploy --plan` counts as a deploy. */
const isDeploy = (reports) => reports.some((r) => /^deploy\b/.test(String(r.command ?? "")))

const orderFor = (reports) => (isDeploy(reports) ? DEPLOY_STAGE_ORDER : CI_STAGE_ORDER)

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

  const order = orderFor(reports)
  const known = order.filter((name) => best.has(name))
  const extra = [...best.keys()].filter((name) => !order.includes(name))
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

  // Deploy stages. A tick against `backup` or `release` says a stage ran; what the reader of a
  // deploy needs is what it did to production — which version is serving, where the dump that
  // could undo it is kept, and whether a rollback fired.
  if (Array.isArray(stage.provisioned) && stage.provisioned.length) {
    parts.push(escapeCell(stage.provisioned.join("; ")))
  }
  if (stage.backup?.path) parts.push(`stored \`${escapeCell(stage.backup.path)}\``)
  else if (stage.backup?.status === "empty-database") parts.push("empty database, nothing to dump")
  if (Array.isArray(stage.applied)) {
    parts.push(stage.applied.length ? `applied ${escapeCell(stage.applied.join(", "))}` : "nothing pending")
  }
  if (stage.released) {
    parts.push(`\`${escapeCell(stage.released)}\`${stage.previous ? ` (was \`${escapeCell(stage.previous)}\`)` : ""}`)
  }
  if (stage.rolledBackTo) parts.push(`rolled back to \`${escapeCell(stage.rolledBackTo)}\``)
  if (stage.verified?.version) parts.push(`/health \`${escapeCell(stage.verified.version)}\``)
  if (Array.isArray(stage.rollbackWindow)) {
    parts.push(`${stage.rollbackWindow.length} version(s) left to roll back to`)
  }

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

/**
 * What an unattended deploy left for the person it stopped for.
 *
 * `deploy --auto` exits 4 when the plan is not one it may approve on its own. The run is red
 * and the plan is in a log nobody will open, so the summary carries the plan itself and the
 * one command that executes it — otherwise "confirmation required" is a dead end.
 */
function confirmationLines(reports) {
  const stopped = reports.find((r) => r.exitCode === CONFIRM)
  if (!stopped) return []

  const lines = ["", "### Confirmation required", "", escapeCell(stopped.error ?? "this deploy needs a person")]
  if (stopped.rendered) lines.push("", "```", ...String(stopped.rendered).split("\n"), "```")
  const token = stopped.plan?.token
  const stage = Array.isArray(stopped.plan?.stages) ? ` --stage=${stopped.plan.stages.join(",")}` : ""
  lines.push(
    "",
    token
      ? "Read the plan above. If it is what should happen, run it from a checkout of this commit:"
      : "Read the plan, then confirm it from a checkout of this commit:",
    "",
    "```",
    token ? `shipkit deploy --yes=${token}${stage}` : "shipkit deploy --plan   # then: shipkit deploy --yes=<token>",
    "```",
    "",
    "The token is a hash of the plan: if production moves in the meantime it stops matching, " +
      "and `--plan` has to be read again. It proves the plan was displayed, never that anyone agreed to it.",
  )
  return lines
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
  // A deploy that stopped for confirmation did not fail: nothing is wrong, and nothing was
  // deployed. Saying "failed" sends the reader looking for a broken thing. A real failure
  // anywhere still outranks it — "stopped" must never cover for one.
  const broken = reports.some((r) => r.ok === false && r.exitCode !== CONFIRM) || bad.length > 0
  const stopped = reports.some((r) => r.exitCode === CONFIRM)
  const sha = reports.find((r) => r.sha && r.sha !== "dev")?.sha
  const seconds = reports.reduce((total, r) => total + (r.seconds ?? 0), 0)
  const dirty = reports.some((r) => r.dirty)

  // What a deploy did to production, above the table: the target it changed and the version
  // that is serving because of this run.
  const target = reports.find((r) => r.plan)?.plan
  const released = stages.find((s) => s.name === "release" && s.status === "ok")?.released
  const subtitle = [
    sha ? `Commit \`${sha.slice(0, 7)}\`` : "",
    target ? `${target.env} (${escapeCell(target.url)})` : "",
    released ? `deployed \`${escapeCell(released)}\`` : "",
    `${Math.round(seconds)}s of stage time`,
  ].filter(Boolean)

  const lines = [
    `## ${title} — ${broken ? "failed" : stopped ? "stopped" : "ok"}`,
    "",
    subtitle.join(" · "),
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
  lines.push(...confirmationLines(reports))
  lines.push(...failureDetails(stages))

  const error = reports.find((r) => r.ok === false)
  if (error?.next) lines.push("", `**Next:** ${escapeCell(error.next)}`)

  return lines.join("\n") + "\n"
}
