import { test } from "node:test"
import assert from "node:assert/strict"
import {
  IMPLEMENTED_STACKS,
  stackConfigProblem,
  stackRequirements,
  stackVersionText,
} from "../.dagger/src/adapters/requirements.ts"

/**
 * What each stack may demand of shipkit.yaml. The rule these tests exist for: whatever was
 * relaxed for Next must still be required of dotnet — a client project that leaves out
 * something the build needs has to fail as a message, not as a stack trace deep in a
 * container.
 */

const dotnet = (over: Record<string, unknown> = {}) => ({ project: "src/Api", ...over })
const next = (over: Record<string, unknown> = {}) => ({ lint: "eslint", db: "none", ...over })

test("both implemented stacks accept a minimal, correct config", () => {
  assert.equal(stackConfigProblem("dotnet", dotnet()), null)
  assert.equal(stackConfigProblem("next", next()), null)
})

test("a stack with no adapter is refused, and the message says which have one", () => {
  for (const stack of ["nest", "custom"] as const) {
    const problem = stackConfigProblem(stack, {})
    assert.match(problem?.message ?? "", new RegExp(`stack "${stack}" has no adapter`))
    assert.match(problem?.next ?? "", /dotnet, next/)
  }
  assert.deepEqual([...IMPLEMENTED_STACKS], ["dotnet", "next"])
})

test("project stays required for dotnet and is not demanded of next", () => {
  const problem = stackConfigProblem("dotnet", { project: undefined })
  assert.match(problem?.message ?? "", /"project" is required for stack "dotnet"/)
  assert.match(stackConfigProblem("dotnet", { project: "" })?.message ?? "", /"project" is required/)

  assert.equal(stackConfigProblem("next", next({ project: undefined })), null)
})

test("next names its linter; dotnet has one and may not pretend to choose", () => {
  assert.match(
    stackConfigProblem("next", next({ lint: undefined }))?.message ?? "",
    /"lint" is required for stack "next" and must be one of: eslint, biome/,
  )
  assert.match(stackConfigProblem("next", next({ lint: "prettier" }))?.message ?? "", /must be one of/)
  assert.equal(stackConfigProblem("next", next({ lint: "biome" })), null)

  assert.match(
    stackConfigProblem("dotnet", dotnet({ lint: "eslint" }))?.message ?? "",
    /"lint" does not apply to stack "dotnet"/,
  )
})

test("a stack with no database adapter may not be configured with a database", () => {
  // Otherwise the core skips the db stage for want of an adapter (`!adapter.db`), and the
  // migration gates are absent rather than failed.
  const problem = stackConfigProblem("next", next({ db: "postgres" }))
  assert.match(problem?.message ?? "", /stack "next" has no database adapter, so db must be "none"/)
  assert.equal(stackConfigProblem("dotnet", dotnet({ db: "postgres" })), null)
})

test("stackVersion is a version of something different per stack", () => {
  assert.equal(stackConfigProblem("dotnet", dotnet({ stackVersion: "9.0" })), null)
  assert.equal(stackConfigProblem("next", next({ stackVersion: "22" })), null)
  assert.equal(stackConfigProblem("next", next({ stackVersion: "22.11.0" })), null)

  // A Node major is not a target framework, and the message says so rather than failing later
  // with "no such image mcr.microsoft.com/dotnet/sdk:22".
  assert.match(stackConfigProblem("dotnet", dotnet({ stackVersion: "22" }))?.message ?? "", /stackVersion/)
  assert.match(stackConfigProblem("next", next({ stackVersion: "22-alpine" }))?.message ?? "", /stackVersion/)
  assert.match(stackConfigProblem("next", next({ stackVersion: "22;id" }))?.message ?? "", /stackVersion/)
})

test("unquoted YAML numbers are read as text, and refused when the shape needs more", () => {
  // `stackVersion: 22` parses as the number 22, `10.0` as the number 10.
  assert.equal(stackVersionText(22), "22")
  assert.equal(stackConfigProblem("next", next({ stackVersion: 22 })), null)

  const problem = stackConfigProblem("dotnet", dotnet({ stackVersion: 10 }))
  assert.match(problem?.message ?? "", /stackVersion/)
  assert.match(problem?.next ?? "", /quoted/)
})

test("an unknown stack gets the strictest requirements, never the lenient ones", () => {
  const unknown = stackRequirements("something-else")
  assert.equal(unknown.needsProject, true)
  assert.equal(unknown.supportsDb, true)
})

test("every implemented stack has its own requirements", () => {
  assert.equal(stackRequirements("next").needsProject, false)
  assert.equal(stackRequirements("next").supportsDb, false)
  assert.equal(stackRequirements("next").version.fallback, "22")
  assert.equal(stackRequirements("dotnet").version.fallback, "10.0")
})
