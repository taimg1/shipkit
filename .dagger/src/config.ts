import { Directory } from "@dagger.io/dagger"
import { parse } from "yaml"
import { configError } from "./errors.js"

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
   * Runtime identifier for the migration bundle. It MUST match the target server's
   * architecture — a linux-x64 bundle simply will not execute on an arm64 host, and the
   * failure happens on the server, mid-deploy, after the backup has already run.
   */
  targetArch: string
  /** Deploy targets by name; `prod` must exist for `deploy`. */
  environments: Record<string, Environment>
}

export interface Environment {
  /** Public URL the smoke test hits. */
  url: string
  /** SSH host. Absent until the environment is provisioned. */
  host?: string
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

  const service = (c.service as string) ?? ""
  const rawEnvironments = (c.environments ?? {}) as Record<string, Record<string, unknown>>
  const environments: Record<string, Environment> = {}

  for (const [name, env] of Object.entries(rawEnvironments)) {
    if (!env || typeof env.url !== "string") {
      throw configError(`environment "${name}" needs a url`)
    }
    environments[name] = {
      url: env.url,
      host: env.host as string | undefined,
      sshPort: Number(env.sshPort ?? 22),
      sshUser: (env.sshUser as string) ?? "root",
      // Kamal names an accessory's container "<service>-<accessory>" and puts it on a
      // network called "kamal". Deriving them keeps two more values out of every config,
      // and either can be overridden when a project does something else.
      dbContainer: (env.dbContainer as string) ?? (service ? `${service}-db` : undefined),
      network: (env.network as string) ?? "kamal",
      database: (env.database as string) ?? "app",
      dbUser: (env.dbUser as string) ?? "postgres",
    }
  }

  return {
    kit: c.kit as string | undefined,
    stack: stack as StackName,
    db,
    delivery,
    health: (c.health as string) ?? "/health",
    project: req(c, "project"),
    migrationsProject: c.migrationsProject as string | undefined,
    dockerfile: (c.dockerfile as string) ?? "Dockerfile",
    registry: (c.registry as string) ?? "",
    service,
    targetArch: (c.targetArch as string) ?? "linux-x64",
    defaultBranch: (c.defaultBranch as string) ?? "main",
    publish: c.publish === undefined ? true : c.publish === true,
    environments,
  }
}

function req(c: Record<string, unknown>, key: string): string {
  const v = c[key]
  if (typeof v !== "string" || v.length === 0) {
    throw configError(`shipkit.yaml: "${key}" is required`)
  }
  return v
}
