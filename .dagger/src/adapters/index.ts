import { Config } from "../config.js"
import { configError } from "../errors.js"
import { DotnetAdapter } from "./dotnet.js"
import { NextAdapter } from "./next.js"
import { StackAdapter } from "./types.js"

/**
 * The only place that maps a stack name to an implementation. After this call the core
 * holds a StackAdapter and never inspects the name again (ADR 0008).
 */
export function selectAdapter(cfg: Config): StackAdapter {
  switch (cfg.stack) {
    case "dotnet":
      return new DotnetAdapter()
    case "next":
      return new NextAdapter()
    default:
      throw configError(`no adapter for stack "${cfg.stack}"`)
  }
}

export type { StackAdapter, DbAdapter } from "./types.js"
export { IMPLEMENTED_STACKS, stackConfigProblem, stackRequirements } from "./requirements.js"
