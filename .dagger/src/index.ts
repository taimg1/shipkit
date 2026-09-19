/**
 * shipkit — CI/CD for turnkey client projects.
 *
 * Every function returns a JSON report (docs/cli-design.md). The `shipkit` wrapper renders
 * it; `dagger call` prints it raw. Both paths are supported, permanently (ADR 0009).
 */
import { argument, dag, Container, Directory, File, Platform, Secret, func, object } from "@dagger.io/dagger"
import { Config, loadConfig } from "./config.js"
import { selectAdapter } from "./adapters/index.js"
import { resolveTargetFramework, targetFrameworkSources } from "./adapters/dotnet-parse.js"
import { EXIT, ShipkitError, configError, infraError, notImplemented } from "./errors.js"
import { ReportBuilder, execOutput, serialize, withDetail } from "./report.js"
import { dbStage } from "./core/db.js"
import { postgresService } from "./core/postgres.js"
import { push as pushImage } from "./core/push.js"
import { backup as backupProduction, BackupResult } from "./core/backup.js"
import { migrate as runMigrations } from "./core/migrate.js"
import { lastApplied } from "./core/history.js"
import { dockerPlatform, SUPPORTED_RIDS } from "./core/platform.js"
import { parseStages, stageRuns } from "./core/stage-select.js"
import { imageTag, publishDecision, publishedDigest } from "./core/publish-gate.js"
import { versionMatchesTag } from "./core/health.js"
import { parseVersionProbe, versionProbeScript } from "./core/server-probe.js"
import { remoteScript, sshContainer } from "./core/ssh.js"
import { servingVersion as servingHealth } from "./core/verify.js"
import { waitForDatabase } from "./core/postgres-remote.js"
import {
  bootDatabase,
  clean as cleanServer,
  currentVersion,
  release as releaseImage,
  rollback as rollbackTo,
} from "./core/release.js"
import { verify as verifyHealth } from "./core/verify.js"
import { buildPlan, renderPlan } from "./core/plan.js"
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
import { noTestsRan, testsFailed } from "./core/gates.js"

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
    buildArgs: [{ name: "GIT_SHA", value: sha }],
  })
  // Kamal refuses an image without this label, and only labels images it built itself.
  // Found the hard way: "Image ... is missing the 'service' label".
  return cfg.service ? built.withLabel("service", cfg.service) : built
}

/** Excluded at the source boundary: build output busts Dagger's cache on every run. */
const IGNORE = ["**/bin", "**/obj", "**/node_modules", "**/.git", "**/.shipkit"]

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

      const plan = await buildPlan(source, cfg, env, target, adapter, sha, sshKey, cfg.health, registryToken)
      r.set("plan", plan)
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
    /**
     * The project's .kamal/secrets with its references resolved by the wrapper. Without it the
     * container running Kamal has no values for anything the project declares as a secret, and
     * Kamal deploys an empty string in their place (#19).
     */
    kamalSecrets?: Secret,
  ): Promise<string> {
    const r = new ReportBuilder("deploy", sha)
    const tag = imageTag(sha)
    let previousVersion: string | null = null
    let plannedProvision: string[] = []

    try {
      const { cfg, adapter, target } = await resolveTarget(source, env)
      if (!sshKey) {
        throw new ShipkitError(
          EXIT.CONFIG,
          "deploy needs an SSH key for the target",
          "Pass --ssh-key=file:<path> or set SHIPKIT_SSH_KEY.",
        )
      }

      const stages = parseStages(stage, DEPLOY_STAGES)
      if (stages.unknown.length > 0) throw unknownStage(stages.unknown, DEPLOY_STAGES)
      const only = (name: string) => stageRuns(stages, name)

      // Reading is not changing: a backup or a verify on its own changes nothing production
      // serves (a backup only adds a dump to its own directory). Any other selected stage does,
      // and one of them is enough.
      const changesProduction =
        stages.selected === null ||
        [...stages.selected].some((name) => !READ_ONLY_STAGES.includes(name))

      if (changesProduction) {
        if (!planToken) {
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
      if (cfg.delivery === "kamal") {
        let deployYml: string | null = null
        try {
          deployYml = await source.file("config/deploy.yml").contents()
        } catch {
          // No deploy.yml: Kamal would fail on its own, with its own message.
        }
        if (deployYml) {
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
      }

      const plan = await buildPlan(source, cfg, env, target, adapter, sha, sshKey, cfg.health, registryToken)
        r.set("plan", plan)
        if (plan.token !== planToken) {
          throw new ShipkitError(
            EXIT.CONFIRM,
            `the plan has changed since it was shown (token ${planToken} is now ${plan.token})`,
            "Run `shipkit deploy --plan` again, look at what changed, and confirm the new plan.",
          )
        }
        previousVersion = plan.currentImageTag
        plannedProvision = plan.provision
      }

      if (plannedProvision.length > 0) {
        await r.stage("provision", async () => {
          if (plannedProvision.some((step) => step.startsWith("boot the database"))) {
            await bootDatabase(source, target, sshKey, tag, registryToken, kamalSecrets)
            await waitForDatabase(target, sshKey)
          }
          return withDetail(plannedProvision, { provisioned: plannedProvision })
        })
      } else r.skip("provision", "server already provisioned")

      let backupResult: BackupResult | null = null
      if (only("backup")) {
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
      } else r.skip("backup", "not selected")

      if (only("migrate")) {
        if (cfg.db === "none" || !adapter.db) {
          r.skip("migrate", `db=${cfg.db}`)
        } else if (!dbUrl) {
          throw new ShipkitError(
            EXIT.CONFIG,
            "migrate needs the production connection string",
            "Pass --db-url=env:SHIPKIT_DATABASE_URL.",
          )
        } else {
          await r.stage("migrate", async () => {
            const from = await lastApplied(target, adapter.db!, sshKey)
            const pending = await adapter.db!.pendingList(source, cfg, from)
            const result = await runMigrations(
              source, cfg, target, adapter.db!, sshKey, dbUrl, pending, backupResult,
            )
            return withDetail(result, { from, applied: result.applied })
          })
        }
      } else r.skip("migrate", "not selected")

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
            const result = await verifyHealth(target, cfg.health, sha)
            return withDetail(result, { verified: result })
          })
        } catch (err) {
          // Gate 4 failed: the release did not take. Put the previous image back before
          // anything else, then report red. The database is NOT rolled back — migrations
          // roll forward, and the backup exists for the other case (ADR 0005).
          if (previousVersion) {
            await r.stage("rollback", async () => {
              await rollbackTo(source, target, sshKey, previousVersion!, registryToken, kamalSecrets)
              return withDetail(previousVersion!, {
                rolledBackTo: previousVersion,
                note: "the database was not rolled back; migrations roll forward",
                backup: backupResult,
              })
            })
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
          return withDetail(summary, { pruned: summary })
        })
      } else r.skip("clean", "not selected")

      r.skipRemaining(DEPLOY_STAGES)
      return serialize(r.success())
    } catch (err) {
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
      const { cfg, target } = await resolveTarget(source, env)
      if (!sshKey) {
        throw new ShipkitError(
          EXIT.CONFIG,
          "backup needs an SSH key for the target",
          "Pass --ssh-key=file:<path> or set SHIPKIT_SSH_KEY.",
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
      const { cfg, target } = await resolveTarget(source, env)
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

      // `kamal rollback` over a pruned image exits 0 and changes nothing, and the deploy's own
      // clean stage is what prunes it. Asked here so the refusal names the real reason instead
      // of arriving as a failed verify (#11).
      const imageRef = `${cfg.registry}:${toVersion}`
      const present = parseVersionProbe(
        await sshContainer(target, sshKey)
          .withExec(["sh", "-c", remoteScript(target, versionProbeScript(imageRef))])
          .stdout(),
      )
      if (!present) {
        throw new ShipkitError(
          EXIT.GATE,
          `${toVersion} is not on the server any more`,
          "The deploy's clean stage prunes old images, so it is no longer there to roll back to. " +
            "Deploy that commit again instead — it is still in the registry.",
        )
      }

      await r.stage("rollback", async () => {
        await rollbackTo(source, target, sshKey, toVersion, registryToken, kamalSecrets)
        return toVersion
      })

      await r.stage("verify", async () => {
        const after = await servingHealth(target, cfg.health)
        if (!versionMatchesTag(after, toVersion)) {
          throw new ShipkitError(
            EXIT.GATE,
            `rolled back to ${toVersion} but ${after ?? "nothing"} is answering`,
            "The old version did not take. Check `kamal app version` on the server before trying again.",
          )
        }
        return after!
      })

      r.set("schema", "untouched — migrations roll forward (docs/runbooks/restore.md)")
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
      if (cfg.delivery === "kamal") {
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
      if (cfg.delivery === "kamal") {
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
