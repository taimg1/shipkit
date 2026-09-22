/**
 * shipkit — CI/CD for turnkey client projects.
 *
 * Every function returns a JSON report (docs/cli-design.md). The `shipkit` wrapper renders
 * it; `dagger call` prints it raw. Both paths are supported, permanently (ADR 0009).
 */
import { randomUUID } from "node:crypto"
import { argument, dag, Container, Directory, File, Platform, Secret, func, object } from "@dagger.io/dagger"
import { Config, loadConfig } from "./config.js"
import { selectAdapter } from "./adapters/index.js"
import { resolveTargetFramework, targetFrameworkSources } from "./adapters/dotnet-parse.js"
import { EXIT, ShipkitError, configError, gateError, infraError, notImplemented } from "./errors.js"
import { ReportBuilder, execOutput, serialize, withDetail } from "./report.js"
import { dbStage } from "./core/db.js"
import { postgresService } from "./core/postgres.js"
import { push as pushImage } from "./core/push.js"
import { backup as backupProduction, BackupResult } from "./core/backup.js"
import { migrate as runMigrations } from "./core/migrate.js"
import { lastApplied } from "./core/history.js"
import { dockerPlatform, SUPPORTED_RIDS } from "./core/platform.js"
import { deploySelectionProblem, deployStageProblem, deployStageSkip, parseStages, selectedStages, stageRuns } from "./core/stage-select.js"
import { imageTag, publishDecision, publishedDigest } from "./core/publish-gate.js"
import { versionMatchesTag } from "./core/health.js"
import { parseRetainContainers } from "./core/server-probe.js"
import { servingVersion as servingHealth } from "./core/verify.js"
import { waitForDatabase } from "./core/postgres-remote.js"
import {
  acquireDeployLock,
  availableVersions,
  bootDatabase,
  clean as cleanServer,
  currentVersion,
  pullImage,
  release as releaseImage,
  releaseDeployLock,
  rollback as rollbackTo,
} from "./core/release.js"
import { verify as verifyHealth } from "./core/verify.js"
import { buildPlan, renderPlan } from "./core/plan.js"
import { approvalFacts, autoApproveRefusal } from "./core/auto-approve.js"
import { KamalSsh, checkSsh, declaredSecrets, kamalHostKeyProblem, missingSecrets, parseKamalSsh } from "./core/kamal-config.js"
import { checkHostKey } from "./core/known-hosts.js"
import { StackAdapter } from "./adapters/types.js"

/** Config, adapter and environment, resolved once and validated together. */
async function resolveTarget(source: Directory, env: string) {
  const cfg = await loadConfig(source)
  const adapter = selectAdapter(cfg)
  const target = cfg.environments[env]
  if (!target) {
    throw new ShipkitError(
      EXIT.CONFIG,
      `environment "${env}" is not defined in shipkit.yaml`,
      `Defined: ${Object.keys(cfg.environments).join(", ") || "none"}.`,
    )
  }
  return { cfg, adapter: adapter as StackAdapter, target }
}
import { noTestsRan, rollbackFailed, testsFailed } from "./core/gates.js"

const CI_STAGES = ["pre", "build", "test", "db", "push"]
const DEPLOY_STAGES = ["provision", "backup", "migrate", "release", "verify", "rollback", "clean"]

/** Deploy stages that only read production, so selecting them needs no plan token. */
const READ_ONLY_STAGES = ["backup", "verify"]

/**
 * `--stage` naming something that is not a stage. Refused rather than ignored: an unmatched
 * name selects no stage at all, so the run would do nothing and still exit 0.
 */
function unknownStage(unknown: string[], known: string[]): ShipkitError {
  const names = unknown.map((n) => JSON.stringify(n)).join(", ")
  return configError(
    `not a stage of this command: ${names}`,
    `Stages, in order: ${known.join(", ")}. Several may be given as --stage=build,push.`,
  )
}

/** A stage set that skips a gate the plan depends on (deployStageProblem). */
function unsafeStages(problem: string): ShipkitError {
  return configError(
    `refusing this stage set: ${problem}`,
    "Run the whole deploy (no --stage), or a set that keeps backup -> migrate -> release -> verify together.",
  )
}

/**
 * One definition of "the image", used by `ci` and by `image` alike, so that what gets
 * inspected locally is what gets deployed.
 */
function buildImage(source: Directory, cfg: Config, sha: string): Container {
  // Without an explicit platform the image takes the engine's architecture: amd64 in CI,
  // arm64 on an Apple Silicon workstation. The second one publishes fine and then cannot run
  // on an x86 server — at release, after the migrations (#18).
  const platform = dockerPlatform(cfg.targetArch)
  if (platform === null) {
    throw configError(
      `targetArch "${cfg.targetArch}" is not a runtime identifier the kit can build an image for`,
      `Use one of: ${SUPPORTED_RIDS.join(", ")}.`,
    )
  }
  const built = source.dockerBuild({
    dockerfile: cfg.dockerfile,
    platform: platform as Platform,
    // GIT_SHA first so a project cannot shadow it; config refuses it anyway (config.ts).
    buildArgs: [
      { name: "GIT_SHA", value: sha },
      ...Object.entries(cfg.buildArgs).map(([name, value]) => ({ name, value })),
    ],
  })
  // Kamal refuses an image without this label, and only labels images it built itself.
  // Found the hard way: "Image ... is missing the 'service' label".
  return cfg.service ? built.withLabel("service", cfg.service) : built
}

/** Excluded at the source boundary: build output busts Dagger's cache on every run. */
const IGNORE = ["**/bin", "**/obj", "**/node_modules", "**/.git", "**/.shipkit"]


/**
 * Refuses when config/deploy.yml declares a secret that arrives empty.
 *
 * Kamal writes its env files from these on every command that touches the app — deploy and
 * rollback alike — so an empty one is not a missing value, it is a deployed wrong value.
 */
async function refuseEmptySecrets(source: Directory, kamalSecrets?: Secret): Promise<void> {
  let deployYml: string | null = null
  try {
    deployYml = await source.file("config/deploy.yml").contents()
  } catch {
    // No deploy.yml: Kamal would fail on its own, with its own message.
    return
  }
  const declared = declaredSecrets(deployYml)
  const provided = kamalSecrets ? await kamalSecrets.plaintext() : ""
  const absent = missingSecrets(declared, provided)
  if (absent.length > 0) {
    throw new ShipkitError(
      EXIT.CONFIG,
      `config/deploy.yml declares secrets with no value: ${absent.join(", ")}`,
      "Export them where the deploy runs, and list them in .kamal/secrets as " +
        "NAME=$NAME. A secret that resolves to nothing is deployed as nothing.",
    )
  }
}

@object()
export class Shipkit {
  /**
   * The `ci` pipeline: pre -> build -> test -> db -> push.
   * Runs on every push and pull request.
   */
  @func()
  async ci(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    /** Run a single stage instead of all of them. */
    stage?: string,
    /** Commit SHA being built. Baked into the image and reported by /health. */
    sha = "dev",
    /** Last migration id present on main; the diff base (D4). */
    migrationBase?: string,
    /** Branch being built. Only the default branch publishes; an unknown one never does (core/publish-gate.ts). */
    branch?: string,
    /** Registry credential. A Secret, never a string — it must not reach a log or a report. */
    registryToken?: Secret,
    registryUser?: string,
    /**
     * The source has uncommitted changes, so it is not the commit `sha` names. The image is
     * tagged and versioned `-dirty` and is never published.
     */
    dirty = false,
  ): Promise<string> {
    const r = new ReportBuilder("ci", sha)
    if (dirty) r.set("dirty", true)
    const stages = parseStages(stage, CI_STAGES)
    const only = (name: string) => stageRuns(stages, name)

    try {
      if (stages.unknown.length > 0) throw unknownStage(stages.unknown, CI_STAGES)

      const cfg = await loadConfig(source)
      const adapter = selectAdapter(cfg)
      r.set("stack", adapter.name)

      const restored = adapter.restore(source, cfg)

      if (only("pre")) {
        await r.stage("pre", async () => {
          await adapter.lint(restored, cfg).sync()
        })
      } else r.skip("pre", "not selected")

      // A dirty build must not be able to pass for the commit: not in its tag, and not in the
      // version /health reports, which is what verify compares.
      const version = dirty ? `${sha}-dirty` : sha
      const tag = imageTag(sha, dirty)
      let image: Container | undefined

      if (only("build")) {
        image = await r.stage("build", async () => {
          const built = buildImage(source, cfg, version)
          await built.sync()
          return withDetail(built, { tag })
        })
      } else r.skip("build", "not selected")

      if (only("test")) {
        await r.stage("test", async () => {
          const pg = cfg.db === "none" ? undefined : postgresService("app_test")
          const container = adapter.test(restored, cfg, { postgres: pg })

          let raw: string
          try {
            raw = await container.stdout()
          } catch (err) {
            // A failing run exits non-zero, but its output still carries the counts. Reporting
            // "2 of 3 failed" beats reporting "exit code: 1" — the caller learns the shape of
            // the failure without a second run.
            const out = execOutput(err)
            const summary = out ? adapter.parseTestSummary(out) : null
            if (summary && summary.failed > 0) throw testsFailed(summary)
            throw err
          }

          const summary = adapter.parseTestSummary(raw)
          if (!summary) throw noTestsRan("no summary line in the runner output")
          if (summary.total === 0) throw noTestsRan("total = 0")
          if (summary.failed > 0) throw testsFailed(summary)
          return withDetail(summary, { tests: summary })
        })
      } else r.skip("test", "not selected")

      if (only("db")) {
        if (cfg.db === "none" || !adapter.db) {
          // Skipped explicitly and visibly. A silently omitted gate is how a gate stops
          // being a gate (ADR 0004).
          r.skip("db", `db=${cfg.db}`)
        } else {
          await r.stage("db", () => dbStage(source, cfg, adapter.db!, migrationBase ?? null))
        }
      } else r.skip("db", "not selected")

      if (only("push")) {
        const decision = publishDecision({
          publish: cfg.publish,
          defaultBranch: cfg.defaultBranch,
          branch,
          sha,
          dirty,
          built: image !== undefined,
        })
        if (decision.action === "skip") {
          r.skip("push", decision.reason)
        } else if (decision.action === "refuse") {
          await r.stage("push", async () => {
            throw new ShipkitError(EXIT.CONFIG, decision.reason, decision.next)
          })
        } else {
          await r.stage("push", async () => {
            const address = await pushImage(image!, cfg, tag, registryToken, registryUser)
            // What `deploy` should one day pin to: a tag can be pushed again, a digest cannot.
            const digest = publishedDigest(address)
            if (!digest) throw infraError(`the registry did not return a digest for ${address}`)
            return withDetail(address, { published: address, digest })
          })
        }
      } else r.skip("push", "not selected")

      r.skipRemaining(CI_STAGES)
      return serialize(r.success())
    } catch (err) {
      r.skipRemaining(CI_STAGES)
      return serialize(r.failure(err))
    }
  }

  /**
   * The production image, as a Container.
   *
   * `ci` builds and publishes in one run; this exposes the same image on its own, so it can
   * be exported, inspected, or run locally:
   *
   *   dagger call image --source=. --sha=$(git rev-parse HEAD) export --path=image.tar
   *
   * It is the same code path `build` uses, label included — an image inspected here is the
   * image that would be deployed, not a lookalike.
   */
  @func()
  async image(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    sha = "dev",
  ): Promise<Container> {
    const cfg = await loadConfig(source)
    return buildImage(source, cfg, sha)
  }

  /** Squawk on pending migrations only — seconds, not minutes. */
  @func()
  async dbLint(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    migrationBase?: string,
  ): Promise<string> {
    const r = new ReportBuilder("db lint", "dev")
    try {
      const cfg = await loadConfig(source)
      const adapter = selectAdapter(cfg)
      if (!adapter.db) throw new ShipkitError(EXIT.CONFIG, "this project has no database")
      await r.stage("db", () => dbStage(source, cfg, adapter.db!, migrationBase ?? null))
      return serialize(r.success())
    } catch (err) {
      return serialize(r.failure(err))
    }
  }

  /** Which migrations are not on main / not on prod. */
  @func()
  async dbPending(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    migrationBase?: string,
  ): Promise<string> {
    const r = new ReportBuilder("db pending", "dev")
    try {
      const cfg = await loadConfig(source)
      const adapter = selectAdapter(cfg)
      if (!adapter.db) throw new ShipkitError(EXIT.CONFIG, "this project has no database")
      const pending = await adapter.db.pendingList(source, cfg, migrationBase ?? null)
      r.set("pending", pending)
      return serialize(r.success())
    } catch (err) {
      return serialize(r.failure(err))
    }
  }

  /**
   * Prints what a deploy would do and exits 0 without touching anything.
   *
   * The plan carries a token — a hash of what was displayed. `deploy` requires that exact
   * token, so an agent physically cannot deploy something it has not shown, and a plan that
   * has gone stale (a new commit, production moved, another migration merged) stops matching
   * rather than being quietly executed (ADR 0009).
   */
  // Never cached: it reads a server, and Dagger caches function calls by default. A cached
  // plan describes a production that no longer exists; a cached deploy reports ok without
  // running (#17).
  @func({ cache: "never" })
  async deployPlan(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    env = "prod",
    sha = "dev",
    sshKey?: Secret,
    registryToken?: Secret,
    /** The username sent with the token, as `ci` takes it: the plan asks the registry too. */
    registryUser?: string,
    /** The stages the deploy will run, as `deploy --stage` takes them. The token names them (B7). */
    stage?: string,
  ): Promise<string> {
    const r = new ReportBuilder("deploy --plan", sha)
    try {
      const { cfg, adapter, target } = await resolveTarget(source, env)
      if (!sshKey) {
        throw new ShipkitError(
          EXIT.CONFIG,
          "reading production state needs an SSH key",
          "Pass --ssh-key=file:<path> or set SHIPKIT_SSH_KEY.",
        )
      }

      const stages = parseStages(stage, DEPLOY_STAGES)
      if (stages.unknown.length > 0) throw unknownStage(stages.unknown, DEPLOY_STAGES)

      const plan = await buildPlan(
        source, cfg, env, target, adapter, sha, sshKey, cfg.health, registryToken, registryUser,
        selectedStages(stages, DEPLOY_STAGES),
      )
      r.set("plan", plan)
      const unsafe = deployStageProblem(stages, plan.migrations.length)
      if (unsafe) throw unsafeStages(unsafe)
      r.set("rendered", renderPlan(plan))
      return serialize(r.success())
    } catch (err) {
      return serialize(r.failure(err))
    }
  }

  /**
   * Executes a previously displayed plan.
   *
   * Stage order and the gates between them are fixed by ADR 0004:
   *   backup -> migrate -> release -> verify -> rollback -> clean
   *
   * Every gate fails closed. `--stage` runs one stage for building and debugging the
   * pipeline; stages that change production still need a plan token, read-only ones do not.
   */
  // Never cached: it reads a server, and Dagger caches function calls by default. A cached
  // plan describes a production that no longer exists; a cached deploy reports ok without
  // running (#17).
  @func({ cache: "never" })
  async deploy(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    planToken?: string,
    env = "prod",
    sha = "dev",
    stage?: string,
    sshKey?: Secret,
    dbUrl?: Secret,
    registryToken?: Secret,
    /** The username sent with the token, as `ci` takes it: the plan asks the registry too. */
    registryUser?: string,
    /**
     * The project's .kamal/secrets with its references resolved by the wrapper. Without it the
     * container running Kamal has no values for anything the project declares as a secret, and
     * Kamal deploys an empty string in their place (#19).
     */
    kamalSecrets?: Secret,
    /** Who is deploying, for the deploy lock's holder record. Informational only. */
    actor?: string,
    /**
     * Lets the run confirm its own plan when nobody is there to — a merge to the default
     * branch deploying itself (docs/cli-design.md, "Self-approval").
     *
     * It decides nothing: core/auto-approve.ts does, from the plan, and only for plans with
     * nothing in them worth waking someone for. Anything else still stops with exit 4 and
     * prints its token. Ignored when a plan token is given — a person already said yes.
     */
    autoApprove = false,
  ): Promise<string> {
    const r = new ReportBuilder("deploy", sha)
    const tag = imageTag(sha)
    let previousVersion: string | null = null
    let plannedProvision: string[] = []
    // Set once the server-side deploy lock is held; released before the report is written.
    let unlock: (() => Promise<void>) | null = null

    try {
      const { cfg, adapter, target } = await resolveTarget(source, env)
      if (!sshKey) {
        throw new ShipkitError(
          EXIT.CONFIG,
          "deploy needs an SSH key for the target",
          "Pass --ssh-key=file:<path> or set SHIPKIT_SSH_KEY.",
        )
      }

      // What the report calls this project's database. An adapter with no `db` is the same
      // absence as `db: none` — a stack that has no migrations to apply and no dump to take —
      // and every db-shaped stage below reads this one value rather than asking twice.
      const dbKind = adapter.db ? cfg.db : "none"

      const stages = parseStages(stage, DEPLOY_STAGES)
      if (stages.unknown.length > 0) throw unknownStage(stages.unknown, DEPLOY_STAGES)
      // Before the plan token is asked for: `--stage=rollback` used to demand one and then run
      // nothing (D-06).
      const early = deploySelectionProblem(stages, [])
      if (early) throw configError(early.message, early.next)
      const only = (name: string) => stageRuns(stages, name)

      // Reading is not changing: a backup or a verify on its own changes nothing production
      // serves (a backup only adds a dump to its own directory). Any other selected stage does,
      // and one of them is enough.
      const changesProduction =
        stages.selected === null ||
        [...stages.selected].some((name) => !READ_ONLY_STAGES.includes(name))

      if (changesProduction) {
        // Neither a token nor leave to decide: stop, as this always has. `--auto-approve` is
        // not a token and is not a bypass — it moves the yes from a person to the policy, and
        // the policy says no to everything a person would have wanted to see.
        if (!planToken && !autoApprove) {
          throw new ShipkitError(
            EXIT.CONFIRM,
            "this deploy would change production and has no plan token",
            "Run `shipkit deploy --plan`, show the plan, then `shipkit deploy --yes=<token>`.",
          )
        }
        // The plan is rebuilt from production as it is NOW. If anything it described has
        // changed since it was shown, the token no longer matches and this stops — which is
        // the entire point of hashing the plan rather than passing a boolean.
        // Before anything is planned, let alone booted: every secret config/deploy.yml declares
      // must have a value. Kamal resolves a name it cannot find to an empty string and deploys
      // it, and only PostgreSQL is rude enough to refuse to start over one (#19).
      await refuseEmptySecrets(source, kamalSecrets)

      const plan = await buildPlan(
        source, cfg, env, target, adapter, sha, sshKey, cfg.health, registryToken, registryUser,
        selectedStages(stages, DEPLOY_STAGES),
      )
        r.set("plan", plan)
        // Refused whatever the token says: a plan cannot confirm skipping a gate (B7).
        const unsafe = deployStageProblem(stages, plan.migrations.length)
        if (unsafe) throw unsafeStages(unsafe)
        if (planToken) {
          if (plan.token !== planToken) {
            throw new ShipkitError(
              EXIT.CONFIRM,
              `the plan has changed since it was shown (token ${planToken} is now ${plan.token})`,
              "Run `shipkit deploy --plan` again, look at what changed, and confirm the new plan.",
            )
          }
        } else {
          // Self-approval judges THIS plan — built from production a moment ago — and the
          // deploy then executes exactly it. Nothing is re-planned afterwards, so there is no
          // window between what the policy looked at and what runs.
          await r.stage("approve", async () => {
            const refusal = autoApproveRefusal(plan)
            if (refusal) {
              // The same thing `deploy --plan` prints, so the person this hands over to does
              // not have to go and ask production the same questions again.
              r.set("rendered", renderPlan(plan))
              throw new ShipkitError(
                EXIT.CONFIRM,
                `this deploy cannot approve itself: ${refusal}`,
                `A person has to confirm it:\n\n${renderPlan(plan)}`,
              )
            }
            // The facts, not the verdict. "self-approved: true" is a claim; the day it is
            // wrong is the day someone has to read which facts it was wrong about.
            return withDetail(plan.token, {
              approvedBy: "policy",
              token: plan.token,
              facts: approvalFacts(plan),
            })
          })
        }
        previousVersion = plan.currentImageTag
        plannedProvision = plan.provision

        // One deploy at a time, from here until verify/rollback is done (B13). Kamal's own
        // lock only covers its commands, which start after the backup and the migrations.
        const lockId = randomUUID()
        await acquireDeployLock(target, sshKey, cfg.service, {
          id: lockId, sha, env, actor: actor ?? "unknown",
        })
        unlock = async () => {
          r.set("lock", await releaseDeployLock(target, sshKey, cfg.service, lockId))
        }

        // Before anything changes: the image release will pull must be pullable. release uses
        // --skip-push, so a missing image used to surface after the migrations (B4).
        if (only("release")) {
          try {
            await pullImage(source, target, sshKey, tag, registryToken, kamalSecrets)
          } catch (err) {
            throw new ShipkitError(
              EXIT.GATE,
              `the image ${tag} cannot be pulled onto ${target.host}: ${err instanceof Error ? err.message.slice(0, 300) : err}`,
              "Nothing was changed. Is this commit published? Only a green `ci` on " +
                `${cfg.defaultBranch} pushes an image. Check the registry in config/deploy.yml and its credentials.`,
            )
          }
          r.set("image", `${tag} pulled onto ${target.host}`)
        }
      }

      // Provisioning runs only when selected, and a selection that leaves out provisioning the
      // plan needs is refused before anything starts rather than migrating a server with no
      // database (D-06).
      const late = deploySelectionProblem(stages, plannedProvision)
      if (late) throw configError(late.message, late.next)
      if (plannedProvision.length > 0) {
        await r.stage("provision", async () => {
          if (plannedProvision.some((step) => step.startsWith("boot the database"))) {
            await bootDatabase(source, target, sshKey, tag, registryToken, kamalSecrets)
            await waitForDatabase(target, sshKey)
          }
          return withDetail(plannedProvision, { provisioned: plannedProvision })
        })
      } else r.skip("provision", only("provision") ? "server already provisioned" : "not selected")

      let backupResult: BackupResult | null = null
      const skipBackup = deployStageSkip(stages, "backup", dbKind)
      if (skipBackup) {
        // Skipped explicitly and visibly, exactly as ci's db stage is: this used to run
        // whatever the project was and pg_dump a container a db=none project never has.
        r.skip("backup", skipBackup)
      } else {
        // The dump is stored on the server inside this stage; if it cannot be, the stage fails
        // and migrate never runs.
        backupResult = await r.stage("backup", async () => {
          const { result } = await backupProduction(target, sshKey, {
            service: cfg.service,
            sha,
            retention: cfg.backupRetention,
          })
          return withDetail(result, { backup: result })
        })
      }

      const skipMigrate = deployStageSkip(stages, "migrate", dbKind)
      if (skipMigrate) {
        r.skip("migrate", skipMigrate)
      } else {
        await r.stage("migrate", async () => {
          const from = await lastApplied(target, adapter.db!, sshKey)
          const pending = await adapter.db!.pendingList(source, cfg, from)
          // Asked for here rather than before the stage: a code-only release applies nothing,
          // and refusing it for a credential it will never use is a gate firing at the wrong
          // deploy. Pending migrations and no connection string is still a refusal — and the
          // count comes from the server, now, not from the plan.
          if (!dbUrl && pending.length > 0) {
            throw new ShipkitError(
              EXIT.CONFIG,
              `migrate needs the production connection string for ${pending.length} pending migration(s)`,
              "Pass --db-url=env:SHIPKIT_DATABASE_URL.",
            )
          }
          const result = dbUrl
            ? await runMigrations(source, cfg, target, adapter.db!, sshKey, dbUrl, pending, backupResult)
            : { applied: [], from }
          return withDetail(result, { from, applied: result.applied, timeouts: cfg.migrationTimeouts })
        })
      }

      if (only("release")) {
        await r.stage("release", async () => {
          if (previousVersion === null) {
            previousVersion = await currentVersion(source, target, sshKey, registryToken, kamalSecrets)
          }
          await releaseImage(source, target, sshKey, tag, registryToken, kamalSecrets)
          return withDetail(tag, { released: tag, previous: previousVersion })
        })
      } else r.skip("release", "not selected")

      if (only("verify")) {
        try {
          await r.stage("verify", async () => {
            const result = await verifyHealth(target, { health: cfg.health, ready: cfg.ready }, sha, cfg.verifyTimeout)
            return withDetail(result, { verified: result })
          })
        } catch (err) {
          // Gate 4 failed: the release did not take. Put the previous image back before
          // anything else, then report red. The database is NOT rolled back — migrations
          // roll forward, and the backup exists for the other case (ADR 0005).
          if (previousVersion) {
            const to: string = previousVersion
            try {
              await r.stage("rollback", async () => {
                // `kamal rollback` to a version with no container exits 0 and changes nothing.
                const available = await availableVersions(target, sshKey, cfg.service)
                if (!available.includes(to)) {
                  throw gateError(`${to} is not on the server to roll back to (available: ${available.join(", ") || "none"})`)
                }
                await rollbackTo(source, target, sshKey, to, registryToken, kamalSecrets)
                // Proven, not assumed (B15): the version put back is the one answering, and it
                // can reach the database. An unverified rollback reported as done is a second
                // green lie on top of the first.
                const back = await verifyHealth(
                  target, { health: cfg.health, ready: cfg.ready }, to, cfg.verifyTimeout,
                  (v) => versionMatchesTag(v, to),
                )
                return withDetail(to, {
                  rolledBackTo: to,
                  verified: back,
                  // What was and was not put back. A project with no database has neither to
                  // report, and a note about migrations rolling forward would be the report
                  // describing something this deploy does not have.
                  ...(dbKind === "none"
                    ? {}
                    : {
                        note: "the database was not rolled back; migrations roll forward",
                        backup: backupResult,
                      }),
                })
              })
            } catch (rollbackErr) {
              // Never instead of the verify failure: that is why production is in this state.
              throw rollbackFailed(err, to, rollbackErr)
            }
          } else {
            r.skip("rollback", "no previous version was recorded to roll back to")
          }
          throw err
        }
        r.skip("rollback", "not needed")
      } else r.skip("verify", "not selected")

      if (only("clean")) {
        await r.stage("clean", async () => {
          const summary = await cleanServer(source, target, sshKey, tag, registryToken, kamalSecrets)
          let retain = 5
          try {
            retain = parseRetainContainers(await source.file("config/deploy.yml").contents())
          } catch {
            // No deploy.yml: Kamal's default applies.
          }
          // The rollback window is what survived the prune, read the way `kamal rollback`
          // reads it. Losing the version this deploy replaced leaves the next incident with
          // nothing to go back to, and is a failure rather than a note (C12).
          const available = await availableVersions(target, sshKey, cfg.service)
          const window = available.filter((v) => v !== tag)
          // Only a tag the kit minted can be found by name; anything else was not deployed by
          // it, and a rollback to it is refused regardless (versionMatchesTag).
          const replaced = previousVersion && /^sha-[0-9a-f]{7,40}$/.test(previousVersion) ? previousVersion : null
          if (replaced && replaced !== tag && !window.includes(replaced)) {
            throw gateError(
              `clean removed ${replaced}, the version this deploy replaced: there is nothing to roll back to`,
              "Set retain_containers in config/deploy.yml (Kamal's default is 5) and check what else prunes containers on the server.",
            )
          }
          return withDetail(summary, { pruned: summary, retainContainers: retain, rollbackWindow: window })
        })
      } else r.skip("clean", "not selected")

      if (unlock) {
        await unlock()
        unlock = null
      }
      r.skipRemaining(DEPLOY_STAGES)
      return serialize(r.success())
    } catch (err) {
      if (unlock) await unlock()
      r.skipRemaining(DEPLOY_STAGES)
      return serialize(r.failure(err))
    }
  }

  /**
   * A verified backup of production, on demand.
   *
   * The same code the deploy runs, exposed on its own — a dump that has been proven
   * restorable by restoring it, not one that merely exists, stored on the server like the
   * deploy's and also handed back:
   *
   *   shipkit backup --out prod.pgc
   *
   * Returns a directory rather than the file: `report.json` always, `dump.pgc` only when the
   * backup was verified and stored. A bare File had no room for a report, so a success printed a
   * path the wrapper could not read (exit 3) and a failure was a Dagger error with no report.
   *
   * This is what makes a restore drill something a person can actually do. A backup strategy
   * nobody has restored from is an assumption, and the day it stops being an assumption is
   * the worst possible day to find out.
   */
  // Never cached: it reads a server, and Dagger caches function calls by default. A cached
  // plan describes a production that no longer exists; a cached deploy reports ok without
  // running (#17).
  @func({ cache: "never" })
  async backup(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    env = "prod",
    sha = "dev",
    sshKey?: Secret,
  ): Promise<Directory> {
    const r = new ReportBuilder("backup", sha)
    let dump: File | undefined
    let report: string
    try {
      const { cfg, adapter, target } = await resolveTarget(source, env)
      if (!sshKey) {
        throw new ShipkitError(
          EXIT.CONFIG,
          "backup needs an SSH key for the target",
          "Pass --ssh-key=file:<path> or set SHIPKIT_SSH_KEY.",
        )
      }
      // The deploy skips its backup stage for these projects; asked for one directly, say so
      // rather than fail inside pg_dump against a container that was never there.
      if (cfg.db === "none" || !adapter.db) {
        throw new ShipkitError(
          EXIT.CONFIG,
          `this project has no database to back up (db=${cfg.db})`,
          "Nothing on this server holds data the kit put there.",
        )
      }

      const taken = await r.stage("backup", async () => {
        const out = await backupProduction(target, sshKey, {
          service: cfg.service,
          sha,
          retention: cfg.backupRetention,
        })
        return withDetail(out, { backup: out.result })
      })
      if (!taken.dump) {
        throw new ShipkitError(
          EXIT.GATE,
          `there is nothing to back up: ${taken.result.status === "empty-database" ? taken.result.reason : "no dump was produced"}`,
          "Production has no schema yet. There is no dump to take and nothing to lose.",
        )
      }
      dump = taken.dump
      report = serialize(r.success())
    } catch (err) {
      dump = undefined
      report = serialize(r.failure(err))
    }

    // Production data: readable by whoever runs the command and nobody else, from the first byte.
    const out = dag.directory().withNewFile("report.json", report, { permissions: 0o600 })
    return dump ? out.withFile("dump.pgc", dump, { permissions: 0o600 }) : out
  }

  /**
   * Put a version that was already deployed back in front of traffic.
   *
   * The runbook has described this command since M6 and it did not exist (#11): the only
   * rollback the kit could perform was the automatic one inside a deploy, when `verify` failed.
   * Which is the easy case. The hard case is finding out an hour later, and that had nothing.
   *
   * Schema is not touched. Migrations roll forward (ADR 0005), and a release that has to be
   * undone because of a migration is the restore runbook's problem, not this one's. The command
   * says so rather than pretending otherwise.
   *
   * The target is named explicitly and never inferred. "The previous one" is exactly the thing
   * an operator is least sure of during an incident, and a rollback to a guess is another
   * deploy nobody confirmed.
   */
  // Never cached: it reads the server and changes it (#17).
  @func({ cache: "never" })
  async rollback(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    /** The image tag to put back, as `ci` published it: sha-<commit>. */
    toVersion: string,
    env = "prod",
    sshKey?: Secret,
    registryToken?: Secret,
    kamalSecrets?: Secret,
  ): Promise<string> {
    const r = new ReportBuilder("rollback", toVersion)
    try {
      const { cfg, adapter, target } = await resolveTarget(source, env)
      if (!sshKey) {
        throw new ShipkitError(EXIT.CONFIG, "no ssh key", "Set SHIPKIT_SSH_KEY or pass --ssh-key.")
      }
      if (!/^sha-[0-9a-f]{7,40}$/.test(toVersion)) {
        throw new ShipkitError(
          EXIT.CONFIG,
          `"${toVersion}" is not a tag this pipeline published`,
          "Tags are sha-<commit>. `shipkit deploy --plan` shows the one currently serving.",
        )
      }

      // The same check the deploy makes. Kamal writes its env files from these on every
      // command it runs, rollback included: with nothing behind them the old image comes back
      // up holding an empty connection string.
      await refuseEmptySecrets(source, kamalSecrets)

      const before = await servingHealth(target, cfg.health)
      r.set("serving", before ?? "nothing is answering")

      // Rolling back to what is already serving changes nothing and looks like a fix, which is
      // the worst outcome during an incident.
      if (versionMatchesTag(before, toVersion)) {
        throw new ShipkitError(
          EXIT.GATE,
          `${toVersion} is already what is serving`,
          "Nothing to roll back to. If the site is wrong, this is not the reason.",
        )
      }

      // `kamal rollback` to a version with no container exits 0 and changes nothing. Asked
      // here, the way Kamal asks, so the refusal names the real reason instead of arriving as
      // a failed verify (#11, C12). What else could be rolled back to is part of the answer.
      const available = (await availableVersions(target, sshKey, cfg.service)).filter(
        (v) => !versionMatchesTag(before, v),
      )
      r.set("available", available)
      if (!available.includes(toVersion)) {
        throw new ShipkitError(
          EXIT.GATE,
          `${toVersion} is not on the server any more (${available.length} version(s) available: ${available.join(", ") || "none"})`,
          "Kamal keeps the newest retain_containers stopped containers (config/deploy.yml, default 5) " +
            "and prunes the rest. Deploy that commit again instead — it is still in the registry.",
        )
      }

      await r.stage("rollback", async () => {
        await rollbackTo(source, target, sshKey, toVersion, registryToken, kamalSecrets)
        return toVersion
      })

      await r.stage("verify", async () => {
        try {
          const after = await verifyHealth(
            target, { health: cfg.health, ready: cfg.ready }, toVersion, cfg.verifyTimeout,
            (v) => versionMatchesTag(v, toVersion),
          )
          return withDetail(after.version, { verified: after })
        } catch (err) {
          if (err instanceof ShipkitError) {
            err.next = "The old version did not take, or cannot reach the database. Check `kamal app version` on the server before trying again."
          }
          throw err
        }
      })

      // Only where there is a schema. Telling the reader of a db=none rollback that nothing
      // was done to a database it does not have is noise in the one report read under pressure.
      if (cfg.db !== "none" && adapter.db) {
        r.set("schema", "untouched — migrations roll forward (docs/runbooks/restore.md)")
      }
      return serialize(r.success())
    } catch (err) {
      return serialize(r.failure(err))
    }
  }

  /** Environment and configuration checks, cheapest first. */
  // Never cached: its checks will read servers (#14, #15), and a cached answer is a past one.
  @func({ cache: "never" })
  async doctor(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    const r = new ReportBuilder("doctor", "dev")
    const checks: Record<string, string> = {}
    try {
      const cfg = await loadConfig(source)
      checks["shipkit.yaml"] = "ok"
      checks["stack"] = cfg.stack
      checks["db"] = cfg.db
      checks["delivery"] = cfg.delivery
      checks["environments"] = Object.keys(cfg.environments).join(", ") || "none defined"

      try {
        await source.file(cfg.dockerfile).contents()
        checks["dockerfile"] = `ok (${cfg.dockerfile})`
      } catch {
        checks["dockerfile"] = `MISSING (${cfg.dockerfile})`
      }

      try {
        await source.directory(cfg.project).entries()
        checks["project"] = `ok (${cfg.project})`
      } catch {
        checks["project"] = `MISSING (${cfg.project})`
      }

      // The runtime version is declared in shipkit.yaml and again in the project file.
      // Same rule as the service name: duplication is tolerable when something checks it,
      // and an unchecked copy is how a project on net9.0 gets built with a .NET 10 SDK.
      //
      // A check that cannot run says so with WARN. Reporting it as a pass is how a project with
      // its framework in Directory.Build.props sailed through (#8).
      try {
        const csprojName = (await source.directory(cfg.project).entries()).find((f) => f.endsWith(".csproj"))
        if (!csprojName) {
          checks["stackVersion"] = `WARN no .csproj in ${cfg.project}; ${cfg.stackVersion} not checked`
        } else {
          const files: { path: string; text: string }[] = []
          for (const path of targetFrameworkSources(cfg.project, csprojName)) {
            try {
              files.push({ path, text: await source.file(path).contents() })
            } catch {
              // Absent: MSBuild would not import it either.
            }
          }
          const resolved = resolveTargetFramework(files)
          if (resolved.version === null) {
            checks["stackVersion"] = `WARN ${resolved.reason}; ${cfg.stackVersion} not checked`
          } else if (resolved.version !== cfg.stackVersion) {
            checks["stackVersion"] =
              `MISMATCH (shipkit.yaml "${cfg.stackVersion}" vs ${resolved.from} "net${resolved.version}")`
          } else {
            checks["stackVersion"] = `ok (${cfg.stackVersion}, from ${resolved.from})`
          }
        }
      } catch {
        checks["stackVersion"] = `WARN project directory unreadable; ${cfg.stackVersion} not checked`
      }

      // The pinned host key must be a key for the host and port ssh will actually look up.
      for (const [name, env] of Object.entries(cfg.environments)) {
        if (env.host) checks[`hostKey ${name}`] = checkHostKey(name, env)
      }

      // The kit and Kamal both SSH to the server; they must agree on how (#15).
      {
        let kamal: KamalSsh | null = null
        try {
          const deployYml = await source.file("config/deploy.yml").contents()
          kamal = parseKamalSsh(deployYml)
          const problem = kamalHostKeyProblem(deployYml)
          checks["kamal host keys"] = problem ? `MISMATCH (${problem})` : "ok (verified against hostKey)"
        } catch {
          // No deploy.yml yet: nothing to cross-check, the root warning still applies.
        }
        for (const [name, env] of Object.entries(cfg.environments)) {
          if (env.host) checks[`ssh ${name}`] = checkSsh(name, env, kamal)
        }
      }

      // Kamal's service name is duplicated between shipkit.yaml and config/deploy.yml.
      // Duplication is tolerable when something checks it; silent drift here means an image
      // that builds, publishes, and then cannot be deployed.
      {
        try {
          const deployYml = await source.file("config/deploy.yml").contents()
          const declared = /^service:[ \t]*(\S+)[ \t]*$/m.exec(deployYml)?.[1]
          if (!cfg.service) {
            checks["service"] = `MISSING (config/deploy.yml says "${declared ?? "?"}")`
          } else if (declared && declared !== cfg.service) {
            checks["service"] = `MISMATCH (shipkit.yaml "${cfg.service}" vs deploy.yml "${declared}")`
          } else {
            checks["service"] = `ok (${cfg.service})`
          }
        } catch {
          checks["service"] = cfg.service ? `ok (${cfg.service}), no config/deploy.yml yet` : "MISSING"
        }
      }

      r.set("checks", checks)
      const bad = Object.entries(checks).filter(
        ([, v]) => v.startsWith("MISSING") || v.startsWith("MISMATCH"),
      )
      if (bad.length > 0) {
        throw new ShipkitError(
          EXIT.CONFIG,
          `${bad.length} check(s) failed: ${bad.map(([k]) => k).join(", ")}`,
        )
      }
      return serialize(r.success())
    } catch (err) {
      r.set("checks", checks)
      return serialize(r.failure(err))
    }
  }
}
