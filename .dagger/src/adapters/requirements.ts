import type { StackName } from "../config.js"
import type { ConfigProblem } from "../config-validate.js"

/**
 * What each stack demands of shipkit.yaml — the half of the seam that exists before any
 * adapter does.
 *
 * `shipkit.yaml` is parsed and validated in the core, before an adapter is chosen
 * (docs/multi-stack-plan.md §8), so config.ts cannot ask an adapter what it needs. With one
 * implementation that was invisible: `project` and `migrationsProject` are arguments for
 * `dotnet ef`, and they were required of every project, including a Next.js site that has no
 * such concept. `stackVersion` had one meaning and one shape for the same reason.
 *
 * The table lives here, next to the implementations it describes, so that a new adapter
 * brings its requirements with it and the core keeps doing a lookup rather than a branch
 * (ADR 0008). Pure and free of Dagger imports, so both config.ts and the tests can load it.
 */

export interface StackRequirements {
  /** Whether `project` names something the build needs. `dotnet ef` will not run without it. */
  needsProject: boolean
  /** What `stackVersion` means for this stack, and the shape it is accepted in. */
  version: VersionRequirement
  /**
   * Lint tools the adapter can run. More than one means the project names which
   * (multi-stack-plan §6 — the adapter does not guess); none means the stack has exactly
   * one and `lint` in shipkit.yaml would be configuration that does nothing.
   *
   * This is an allowlist rather than a shape check: the value reaches a command line, and
   * "one of these two words" is a stronger guarantee than any regex in config-validate.ts.
   */
  lintTools: readonly string[]
  /**
   * Whether the adapter has a DbAdapter. Without one the core skips the db stage
   * (`!adapter.db` in index.ts) — which for `db: postgres` would mean the migration gates
   * quietly not running. So the refusal belongs in config, not in the stage.
   */
  supportsDb: boolean
}

export interface VersionRequirement {
  shape: RegExp
  /** How the value is described when it is refused. */
  expected: string
  /** Used when shipkit.yaml does not say. */
  fallback: string
}

/** The stacks that have an adapter. The rest are named in config.ts and refused here. */
export const IMPLEMENTED_STACKS: readonly StackName[] = ["dotnet", "next"]

const DOTNET: StackRequirements = {
  needsProject: true,
  version: {
    // A .NET target framework: `net10.0` -> `10.0`. Selects the SDK image, the runtime image
    // the migration bundle runs in, and the dotnet-ef major version.
    shape: /^[0-9]+\.[0-9]+$/,
    expected: "major.minor, such as 10.0",
    fallback: "10.0",
  },
  lintTools: [],
  supportsDb: true,
}

const NEXT: StackRequirements = {
  // A Next.js project is built from the repository root: `next build` reads next.config and
  // the app directory, and there is nothing for a `project` path to point at.
  needsProject: false,
  version: {
    // The Node version, as the official image tags it: `22`, or `22.11` to pin further.
    shape: /^[0-9]+(?:\.[0-9]+){0,2}$/,
    expected: "a Node version, such as 22",
    fallback: "22",
  },
  lintTools: ["eslint", "biome"],
  supportsDb: false,
}

const REQUIREMENTS: Partial<Record<StackName, StackRequirements>> = {
  dotnet: DOTNET,
  next: NEXT,
}

/**
 * The requirements for a stack, or the strictest set for one the kit does not implement.
 *
 * The fallback is deliberately the strict one: config-validate.ts checks shapes for any
 * config handed to it, and an unrecognised stack must not be the one that gets the lenient
 * treatment.
 */
export function stackRequirements(stack: string): StackRequirements {
  return REQUIREMENTS[stack as StackName] ?? DOTNET
}

/**
 * Everything about shipkit.yaml that depends on which stack it is, checked before the adapter
 * exists. Returned rather than thrown so it stays testable; config.ts turns it into a config
 * error.
 *
 * `raw` is the parsed YAML, not a Config: these checks decide what a Config may be built from.
 */
export function stackConfigProblem(
  stack: StackName,
  raw: { project?: unknown; lint?: unknown; db?: unknown; stackVersion?: unknown },
): ConfigProblem | null {
  if (!IMPLEMENTED_STACKS.includes(stack)) {
    return {
      message: `stack "${stack}" has no adapter yet`,
      next: `Implemented: ${IMPLEMENTED_STACKS.join(", ")}. See docs/multi-stack-plan.md §7.`,
    }
  }

  const req = stackRequirements(stack)

  if (req.needsProject && (typeof raw.project !== "string" || raw.project.length === 0)) {
    return {
      message: `shipkit.yaml: "project" is required for stack "${stack}"`,
      next: 'The startup project the build and `dotnet ef` are pointed at, e.g. project: src/Api.',
    }
  }

  if (req.lintTools.length > 0) {
    if (typeof raw.lint !== "string" || !req.lintTools.includes(raw.lint)) {
      return {
        message: `shipkit.yaml: "lint" is required for stack "${stack}" and must be one of: ${req.lintTools.join(", ")}`,
        next:
          "Name the tool the project actually uses, e.g. lint: eslint. The adapter does not " +
          "guess — a project linted by the wrong tool passes `pre` without being linted.",
      }
    }
  } else if (raw.lint !== undefined) {
    return {
      message: `shipkit.yaml: "lint" does not apply to stack "${stack}"`,
      next: `The ${stack} adapter has one linter and always runs it. Remove the line.`,
    }
  }

  // YAML reads `22` as a number and `10.0` as the number 10, so the value is compared as text
  // (config.ts stores it the same way). That is how `stackVersion: 10.0` unquoted is refused
  // with "expected major.minor" instead of being built with the .NET 10 SDK by luck.
  if (raw.stackVersion !== undefined && !req.version.shape.test(stackVersionText(raw.stackVersion))) {
    return {
      message: `shipkit.yaml: "stackVersion" is not a version for stack "${stack}": ${JSON.stringify(raw.stackVersion)}`,
      next: `Expected ${req.version.expected}, quoted. Left out it is ${req.version.fallback}.`,
    }
  }

  if (!req.supportsDb && raw.db !== undefined && raw.db !== "none") {
    return {
      message: `shipkit.yaml: stack "${stack}" has no database adapter, so db must be "none"`,
      next:
        "With a database configured but no adapter to migrate it, the db, backup and migrate " +
        "stages would be skipped rather than run — a gate that is not there. A full-stack " +
        "project with Prisma or Drizzle needs that adapter first (docs/multi-stack-plan.md §4).",
    }
  }

  return null
}

/** How a `stackVersion` from YAML is read everywhere: as the text it was written as. */
export function stackVersionText(raw: unknown): string {
  return typeof raw === "string" ? raw : String(raw)
}
