/**
 * What went to production, in the form GitHub records deployments in.
 *
 * Output formatting, which is the wrapper's job (ADR 0009). The Dagger module must never learn
 * about GitHub — the same pipeline has to keep working for a client on GitLab or Gitea
 * (multi-stack-plan §1) — so the one piece of code that knows what a GitHub deployment looks
 * like lives here, in the layer that is rewritten per forge anyway. A client on another forge
 * never calls this; nothing else in the kit changes.
 *
 * The one rule this file exists for: the state comes from the report the deploy wrote, never
 * from whether the job reached its last step. A deployment marked `success` while `verify`
 * failed and the release was rolled back is worse than no record at all — it is the record
 * people consult when they are trying to work out what is serving.
 *
 * Pure, and free of imports, so every shape a report can have is tested over a table rather
 * than against a real run: ok, a gate that failed, a rollback that fired, exit 4, exit 2, and
 * a report that never arrived.
 */

/** The module's exit code for "this needs a person": a stop, not a failure. */
const CONFIRM = 4

/**
 * The environment to record against when the report does not name one — the same default
 * `shipkit deploy` itself applies for `--env` (lib.mjs). A run that failed before it could
 * build a plan never reached the server, so nothing else is known about where it was going.
 */
const DEFAULT_ENV = "prod"

/** GitHub truncates a longer description; better to cut it where it still reads as a sentence. */
const LIMIT = 140

const one = (text) => String(text).replace(/\s*\n\s*/g, " ").trim()

function short(text) {
  const line = one(text)
  return line.length > LIMIT ? `${line.slice(0, LIMIT - 1)}…` : line
}

const stageOf = (report, name) => (report.stages ?? []).find((s) => s.name === name)

/**
 * The deploy report among whatever was collected.
 *
 * `command === "deploy"` exactly: a `deploy --plan` report describes a run that deliberately
 * changed nothing, and it must never become a deployment record.
 */
const deployReport = (reports) => reports.find((r) => String(r.command ?? "") === "deploy")

/**
 * The state, and the sentence that explains it.
 *
 * Everything that is not a verified deploy is a state that says so. There is no branch here
 * that can reach "success" without a `verify` stage that passed — that is the point of reading
 * the report instead of the job's outcome.
 */
function verdict(report) {
  if (!report) {
    // No report at all, or nothing readable in it: the job died before `shipkit deploy` wrote
    // one, or wrote something that is not a report. Either way nobody can say what production
    // is running, and "unknown" is a failure, not a pass.
    return { state: "failure", why: "no deploy report was produced: the job failed before or during `shipkit deploy`" }
  }

  if (report.exitCode === CONFIRM) {
    // Nothing on the server was touched. `inactive` rather than `pending`: pending reads as a
    // deploy still in flight, and this one has finished — it finished by deciding not to.
    return {
      state: "inactive",
      stopped: true,
      why: `stopped for confirmation: ${report.error ?? "this deploy needs a person"}`,
    }
  }

  if (report.ok === true) {
    const verify = stageOf(report, "verify")
    if (verify?.status === "ok") {
      const released = stageOf(report, "release")?.released
      const version = verify.verified?.version
      return {
        state: "success",
        why: `deployed ${released ?? report.sha ?? "this commit"}${version ? ` and /health reports ${version}` : ""}`,
      }
    }
    // Reported ok with nothing having checked the release — a `--stage` selection that left
    // `verify` out, which `--auto` refuses but a hand-run deploy can produce. Nothing proves
    // what is serving, so nothing here may claim it.
    return {
      state: "inactive",
      why: `the deploy reported ok but verify did not run (${verify?.reason ?? "no verify stage in the report"}): nothing proves this release is serving`,
    }
  }

  // Everything else is a failure, including a report too malformed to have an `ok`. A gate that
  // said no and infrastructure that broke are both recorded as `failure`: GitHub's `error` and
  // `failure` render identically, and the reason below is what a reader actually needs.
  const rollback = stageOf(report, "rollback")
  if (rollback?.status === "ok" && rollback.rolledBackTo) {
    return { state: "failure", why: `rolled back to ${rollback.rolledBackTo}: ${report.error ?? "the release did not verify"}` }
  }
  const failed = (report.stages ?? []).find((s) => s.status === "failed")
  return {
    state: "failure",
    why: failed ? `${failed.name}: ${failed.reason ?? report.error ?? "failed"}` : (report.error ?? "the deploy failed"),
  }
}

/** A workflow command carries its message on one line, with three characters escaped. */
const annotate = (level, title, message) =>
  `::${level} title=${title}::${one(message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`

const ANNOTATION = {
  success: ["notice", "Deployed"],
  inactive: ["warning", "Deploy stopped"],
  failure: ["error", "Deploy failed"],
}

/**
 * The two GitHub API bodies and the annotation for one run, from the reports it left behind.
 *
 * `env` is the runner's environment, passed in rather than read, so this stays testable.
 */
export function deploymentStatus(reports, env = {}) {
  const report = deployReport(reports)
  const { state, why, stopped } = verdict(report)

  // The commit the deploy actually released, not the one the workflow happens to be on. They
  // are the same on a push to the default branch, and the report is the one that knows.
  const ref = report?.sha && report.sha !== "dev" ? report.sha : env.GITHUB_SHA
  // Named by shipkit.yaml, through the plan: `environments:` is where the client writes both
  // the name and the URL, and the kit has no second opinion about either.
  const environment = report?.plan?.env ?? DEFAULT_ENV
  const url = report?.plan?.url

  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined

  const description = short(why)

  return {
    annotation: annotate(...ANNOTATION[state], stopped ? `${why}. The plan and the command that executes it are in this job's summary.` : why),
    deployment: {
      ref,
      environment,
      description: short(`shipkit deploy --auto: ${why}`),
      // Without this GitHub tries to merge the base branch into the ref and answers 202 with
      // no deployment created — the record would silently not exist.
      auto_merge: false,
      // Without this GitHub refuses to create the deployment while any check on the commit is
      // still running (409) — and one always is: this job.
      required_contexts: [],
      transient_environment: false,
      // This job only ever deploys the environment the production branch ships to.
      production_environment: true,
    },
    status: {
      state,
      description,
      // Only when the deploy is the reason that URL serves what it serves. After a rollback
      // the environment is up and answering with the *previous* release; a "View deployment"
      // button next to a failure would point at something this run did not put there.
      ...(state === "success" && url ? { environment_url: url } : {}),
      ...(runUrl ? { log_url: runUrl } : {}),
    },
  }
}
