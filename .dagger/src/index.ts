/**
 * shipkit — CI/CD for turnkey client projects.
 *
 * Every function returns a JSON report (docs/cli-design.md). The `shipkit` wrapper renders
 * it; `dagger call` prints it raw. Both paths are supported, permanently (ADR 0009).
 */
import { argument, dag, Container, Directory, Secret, func, object } from "@dagger.io/dagger"
import { Config, loadConfig } from "./config.js"
import { selectAdapter } from "./adapters/index.js"
import { EXIT, ShipkitError, notImplemented } from "./errors.js"
import { ReportBuilder, execOutput, serialize, withDetail } from "./report.js"
import { dbStage } from "./core/db.js"
import { postgresService } from "./core/postgres.js"
import { push as pushImage } from "./core/push.js"
import { noTestsRan, testsFailed } from "./core/gates.js"
import { digest, planToken, renderPlan, DeployPlan } from "./core/plan.js"

const CI_STAGES = ["pre", "build", "test", "db", "push"]

/**
 * One definition of "the image", used by `ci` and by `image` alike, so that what gets
 * inspected locally is what gets deployed.
 */
function buildImage(source: Directory, cfg: Config, sha: string): Container {
  const built = source.dockerBuild({
    dockerfile: cfg.dockerfile,
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
    /** Branch being built. Only the default branch publishes (see core/push.ts). */
    branch?: string,
    /** Registry credential. A Secret, never a string — it must not reach a log or a report. */
    registryToken?: Secret,
    registryUser?: string,
  ): Promise<string> {
    const r = new ReportBuilder("ci", sha)
    const only = (name: string) => !stage || stage === name

    try {
      const cfg = await loadConfig(source)
      const adapter = selectAdapter(cfg)
      r.set("stack", adapter.name)

      const restored = adapter.restore(source, cfg)

      if (only("pre")) {
        await r.stage("pre", async () => {
          await adapter.lint(restored, cfg).sync()
        })
      } else r.skip("pre", "not selected")

      const tag = `sha-${sha.slice(0, 7)}`
      let image: Container | undefined

      if (only("build")) {
        image = await r.stage("build", async () => {
          const built = buildImage(source, cfg, sha)
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
        if (!cfg.publish) {
          r.skip("push", "publish: false in shipkit.yaml")
        } else if (branch !== undefined && branch !== cfg.defaultBranch) {
          // Not a gate failure — most runs are branch builds and this is their normal end.
          r.skip("push", `branch "${branch}" is not ${cfg.defaultBranch}`)
        } else if (!image) {
          r.skip("push", "no image was built in this run")
        } else {
          await r.stage("push", async () => {
            const address = await pushImage(image!, cfg, tag, registryToken, registryUser)
            return withDetail(address, { published: address })
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
   * The plan carries a token; `deploy` requires that exact token (ADR 0009).
   */
  @func()
  async deployPlan(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    env = "prod",
    sha = "dev",
  ): Promise<string> {
    const r = new ReportBuilder("deploy --plan", sha)
    try {
      const cfg = await loadConfig(source)
      const target = cfg.environments[env]
      if (!target) {
        throw new ShipkitError(
          EXIT.CONFIG,
          `environment "${env}" is not defined in shipkit.yaml`,
          `Defined: ${Object.keys(cfg.environments).join(", ") || "none"}.`,
        )
      }

      // M6 fills these from production: current image tag, last applied migration (D5),
      // the pending SQL, and the last verified backup timestamp.
      throw notImplemented("reading production state for the plan", "M6")

      // Shape kept here so M6 is assembly, not design:
      // const base: Omit<DeployPlan, "token"> = {
      //   env, url: target.url, imageTag: `sha-${sha.slice(0, 7)}`,
      //   currentImageTag, migrations, sqlDigest: digest(sqlText),
      //   sqlPreview: `${sqlText.split("\n").length} lines`,
      //   destructive: false, lastVerifiedBackup,
      // }
      // const plan: DeployPlan = { ...base, token: planToken(base) }
      // r.set("plan", plan); r.set("rendered", renderPlan(plan))
      // return serialize(r.success())
    } catch (err) {
      return serialize(r.failure(err))
    }
  }

  /**
   * Executes a previously displayed plan.
   * `planToken` must match the token printed by `deployPlan`, or this refuses.
   */
  @func()
  async deploy(
    @argument({ defaultPath: ".", ignore: IGNORE }) source: Directory,
    planToken?: string,
    env = "prod",
    sha = "dev",
    sshKey?: Secret,
    registryToken?: Secret,
  ): Promise<string> {
    const r = new ReportBuilder("deploy", sha)
    try {
      await loadConfig(source)
      if (!planToken) {
        throw new ShipkitError(
          EXIT.CONFIRM,
          "deploy requires a plan token",
          "Run `shipkit deploy --plan`, show the plan, then `shipkit deploy --yes=<token>`.",
        )
      }
      throw notImplemented("deploy", "M6")
    } catch (err) {
      return serialize(r.failure(err))
    }
  }

  /** Environment and configuration checks, cheapest first. */
  @func()
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
