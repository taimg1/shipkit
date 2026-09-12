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
  /** Deploy targets by name; `prod` must exist for `deploy`. */
  environments: Record<string, { url: string }>
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

  const environments = (c.environments ?? {}) as Config["environments"]
  for (const [name, env] of Object.entries(environments)) {
    if (!env || typeof env.url !== "string") {
      throw configError(`environment "${name}" needs a url`)
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
