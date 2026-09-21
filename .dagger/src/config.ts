import { Directory } from "@dagger.io/dagger"
import { parse } from "yaml"
import { configError } from "./errors.js"
import { hostKeyHint, parseKnownHosts } from "./core/known-hosts.js"
import { configProblem } from "./config-validate.js"
import { parseRetention } from "./core/backup-store.js"
import { DEFAULT_MIGRATION_TIMEOUTS, MigrationTimeouts, pgDuration } from "./core/migrate-options.js"
import { verifySettings } from "./core/health.js"

export type StackName = "dotnet" | "nest" | "next" | "custom"
export type DbKind = "postgres" | "none"
export type Delivery = "kamal" | "static"

export interface Config {
  /** Pinned kit version the client repo depends on, e.g. github.com/…/shipkit@v1.0.0 */
  kit?: string
  stack: StackName
  db: DbKind
  delivery: Delivery
  health: string
  /**
   * Readiness path: 200 only when the application can reach its database. Required unless
   * db is "none"; `verify` demands it after every release, on top of the version on `health`.
   */
  ready?: string
  /** Seconds `verify` keeps retrying before the release is declared failed. Default 60. */
  verifyTimeout: number
  /** Path to the startup project — required by `dotnet ef`, never guessed. */
  project: string
  /** Path to the project holding the migrations. Differs from `project` in most solutions. */
  migrationsProject?: string
  dockerfile: string
  registry: string
  /**
   * Kamal's service name. It must match `service:` in config/deploy.yml — Kamal refuses to
   * deploy an image that does not carry a matching `service` label, and it only applies that
   * label to images it built itself. Ours are built by the pipeline, so the kit applies it.
   *
   * `doctor` cross-checks the two, because a duplicated value nobody verifies is a value
   * that drifts.
   */
  service: string
  /** Merges to this branch are what may be published. */
  defaultBranch: string
  /**
   * Whether this project publishes an image at all. False for test fixtures, libraries, and
   * anything deployed from somewhere other than a registry.
   */
  publish: boolean
  /**
   * The language runtime version the project targets — `9.0`, `10.0`.
   *
   * Selects the SDK image, the image the migration bundle runs in, and the dotnet-ef major
   * version. It was hardcoded to 10.0 until a real project turned out to be on 9.0, which is
   * the kind of assumption a fixture written alongside the tool can never catch.
   *
   * `doctor` cross-checks it against the startup project's TargetFramework.
   */
  stackVersion: string
  /**
   * Runtime identifier for the migration bundle. It MUST match the target server's
   * architecture — a linux-x64 bundle simply will not execute on an arm64 host, and the
   * failure happens on the server, mid-deploy, after the backup has already run.
   */
  targetArch: string
  /**
   * How many verified pre-deploy dumps to keep on the server, per service. Older ones are
   * deleted after each new one is stored. Default 10.
   */
  backupRetention: number
  /** Deploy targets by name; `prod` must exist for `deploy`. */
  environments: Record<string, Environment>
  /**
   * lock_timeout and statement_timeout for the connection the migration bundle opens
   * (`migrations:` in shipkit.yaml). They are why Squawk's two timeout rules can stay excluded.
   */
  migrationTimeouts: MigrationTimeouts
}

export interface Environment {
  /** Public URL the smoke test hits. */
  url: string
  /** SSH host. Absent until the environment is provisioned. */
  host?: string
  /**
   * known_hosts line(s) for `host`, committed with the project. Public, not a secret — and the
   * only thing that tells the pipeline it is talking to the real server (core/known-hosts.ts).
   */
  hostKey?: string
  sshPort: number
  sshUser: string
  /** PostgreSQL container on the server. Defaults to Kamal's accessory naming. */
  dbContainer?: string
  /** Docker network the database is on. Defaults to Kamal's. */
  network: string
  database: string
  dbUser: string
}

const STACKS: StackName[] = ["dotnet", "nest", "next", "custom"]

/**
 * Parses and validates shipkit.yaml. Runs in the core, before any adapter is chosen —
 * a misconfiguration must fail as a message, never as a stack trace, and never as a
 * silently applied default.
 */
export async function loadConfig(source: Directory): Promise<Config> {
  let raw: string
  try {
    raw = await source.file("shipkit.yaml").contents()
  } catch {
    throw configError(
      "shipkit.yaml not found at the repository root",
      "Create shipkit.yaml — see shipkit.example.yaml in the shipkit repo.",
    )
  }

  let doc: unknown
  try {
    doc = parse(raw)
  } catch (e) {
    throw configError(`shipkit.yaml is not valid YAML: ${(e as Error).message}`)
  }
  if (typeof doc !== "object" || doc === null) {
    throw configError("shipkit.yaml must contain a mapping")
  }
  const c = doc as Record<string, unknown>

  const stack = req(c, "stack")
  if (!STACKS.includes(stack as StackName)) {
    throw configError(`unknown stack "${stack}"`, `Supported: ${STACKS.join(", ")}.`)
  }
  if (stack !== "dotnet") {
    throw configError(
      `stack "${stack}" is not supported in v1`,
      "v1 ships the dotnet adapter only. See docs/multi-stack-plan.md.",
    )
  }

  const db = (c.db as DbKind) ?? "postgres"
  if (db !== "postgres" && db !== "none") throw configError(`db must be "postgres" or "none"`)

  const delivery = (c.delivery as Delivery) ?? "kamal"
  if (delivery !== "kamal" && delivery !== "static") {
    throw configError(`delivery must be "kamal" or "static"`)
  }

  const verifyCfg = verifySettings(c, db)
  if (!verifyCfg.ok) throw configError(verifyCfg.message, verifyCfg.next)

  const service = (c.service as string) ?? ""
  const retention = parseRetention(c.backupRetention)
  if (!retention.ok) throw configError(retention.reason, "Set it to how many dumps to keep, e.g. 10.")
  const rawEnvironments = (c.environments ?? {}) as Record<string, Record<string, unknown>>
  const environments: Record<string, Environment> = {}

  for (const [name, env] of Object.entries(rawEnvironments)) {
    if (!env || typeof env.url !== "string") {
      throw configError(`environment "${name}" needs a url`)
    }
    // No silent root: a server that is deployed to over SSH names the user it is deployed as.
    // Defaulting to root worked on every simulated run and would stop working the day the real
    // server's root login is disabled (#15).
    if (env.host !== undefined && typeof env.sshUser !== "string") {
      throw configError(
        `environment "${name}" has a host but no sshUser`,
        'Add sshUser (e.g. "deploy") — the same user as ssh.user in config/deploy.yml.',
      )
    }
    // No host without its key: without a pin every connection trusts whoever answers first.
    const sshPort = Number(env.sshPort ?? 22)
    if (env.host !== undefined && (typeof env.hostKey !== "string" || env.hostKey.trim() === "")) {
      throw configError(
        `environment "${name}" has a host but no hostKey`,
        hostKeyHint(String(env.host), sshPort),
      )
    }
    if (env.hostKey !== undefined) {
      try {
        parseKnownHosts(String(env.hostKey))
      } catch (e) {
        throw configError(`environment "${name}": ${(e as Error).message}`, hostKeyHint(String(env.host ?? "<host>"), sshPort))
      }
    }
    environments[name] = {
      url: env.url,
      host: env.host as string | undefined,
      hostKey: env.hostKey === undefined ? undefined : String(env.hostKey),
      sshPort,
      sshUser: (env.sshUser as string) ?? "",
      // Kamal names an accessory's container "<service>-<accessory>" and puts it on a
      // network called "kamal". Deriving them keeps two more values out of every config,
      // and either can be overridden when a project does something else.
      dbContainer: (env.dbContainer as string) ?? (service ? `${service}-db` : undefined),
      network: (env.network as string) ?? "kamal",
      database: (env.database as string) ?? "app",
      dbUser: (env.dbUser as string) ?? "postgres",
    }
  }

  const rawMigrations = (c.migrations ?? {}) as Record<string, unknown>
  const migrationTimeouts = { ...DEFAULT_MIGRATION_TIMEOUTS }
  for (const key of ["lockTimeout", "statementTimeout"] as const) {
    if (rawMigrations[key] === undefined) continue
    const value = pgDuration(rawMigrations[key])
    if (value === null) {
      throw configError(
        `migrations.${key} must be a PostgreSQL duration with a unit, e.g. "5s" or "15min"`,
        "A bare number is milliseconds to PostgreSQL, and 0 switches the timeout off.",
      )
    }
    migrationTimeouts[key] = value
  }

  const config: Config = {
    kit: c.kit as string | undefined,
    stack: stack as StackName,
    db,
    delivery,
    health: (c.health as string) ?? "/health",
    ready: verifyCfg.ready,
    verifyTimeout: verifyCfg.verifyTimeout,
    project: req(c, "project"),
    migrationsProject: c.migrationsProject as string | undefined,
    dockerfile: (c.dockerfile as string) ?? "Dockerfile",
    registry: (c.registry as string) ?? "",
    service,
    stackVersion: (c.stackVersion as string) ?? "10.0",
    targetArch: (c.targetArch as string) ?? "linux-x64",
    defaultBranch: (c.defaultBranch as string) ?? "main",
    publish: c.publish === undefined ? true : c.publish === true,
    backupRetention: retention.value,
    environments,
    migrationTimeouts,
  }
  // Every value that reaches a shell is checked for shape here, before anything runs.
  const problem = configProblem(config)
  if (problem) throw configError(problem.message, problem.next)
  return config
}

function req(c: Record<string, unknown>, key: string): string {
  const v = c[key]
  if (typeof v !== "string" || v.length === 0) {
    throw configError(`shipkit.yaml: "${key}" is required`)
  }
  return v
}
