import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  ALPINE_IMAGE,
  KAMAL_IMAGE,
  POSTGRES_IMAGE,
  RUNTIME_DEPS_VERSIONS,
  SQUAWK_BASE_IMAGE,
  runtimeDepsImage,
} from "../.dagger/src/core/images.ts"

const PINNED = /^[a-z0-9./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/

test("every infrastructure image the module runs is pinned by digest", () => {
  for (const image of [ALPINE_IMAGE, KAMAL_IMAGE, POSTGRES_IMAGE, SQUAWK_BASE_IMAGE]) {
    assert.match(image, PINNED)
  }
})

test("the migration runner is pinned for every .NET version the kit knows", () => {
  assert.ok(RUNTIME_DEPS_VERSIONS.includes("10.0"))
  for (const v of RUNTIME_DEPS_VERSIONS) assert.match(runtimeDepsImage(v)!, PINNED)
})

// No pin means no runner, not an unpinned one: it runs with the production connection string.
test("a .NET version without a pin has no runner", () => {
  assert.equal(runtimeDepsImage("7.0"), null)
  assert.equal(runtimeDepsImage("constructor"), null)
})

// The compose files, the dev-server Dockerfile and the fixture's Kamal accessory are outside
// the module, and each used to name a tag.
test("images outside the module are pinned by digest too", () => {
  const files = [
    "dev-server/docker-compose.yml",
    "dev-server/Dockerfile",
    "monitoring/docker-compose.yml",
    "fixtures/dotnet-api/config/deploy.yml",
    "fixtures/dotnet-api/docker-compose.yml",
  ]
  for (const file of files) {
    const refs = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .map((l) => /^\s*(?:image:|FROM)\s+(\S+)/.exec(l)?.[1])
      .filter((r): r is string => r !== undefined && r !== "shipkit-fixture")
    assert.ok(refs.length > 0, file)
    for (const ref of refs) assert.match(ref, PINNED, `${file}: ${ref}`)
  }
})

// C9: a tag on an action can be moved to other code; these steps run beside a write token.
test("every action in the workflows is pinned by commit, with its version beside it", () => {
  const files = [
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    "templates/github/ci.yml",
    "templates/github/ci-no-db.yml",
    "templates/github/actions/setup/action.yml",
  ]
  for (const file of files) {
    const code = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
    const uses = code
      .map((l) => /^\s*(?:-\s+)?uses:\s+(.+)$/.exec(l)?.[1])
      .filter((u): u is string => u !== undefined && !u.startsWith("./"))
    assert.ok(uses.length > 0, file)
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${file}: ${u}`)
    assert.ok(!code.some((l) => l.includes("install.sh")), `${file} pipes an installer into a shell`)
  }
})

test("both workflows default the token to read-only", () => {
  for (const file of [".github/workflows/ci.yml", "templates/github/ci.yml", "templates/github/ci-no-db.yml"]) {
    assert.match(readFileSync(file, "utf8"), /^permissions:\n  contents: read$/m, file)
  }
})

test("Dagger is installed from an archive checked against a pinned sha256", () => {
  for (const file of [".github/actions/setup/action.yml", "templates/github/actions/setup/action.yml"]) {
    const text = readFileSync(file, "utf8")
    assert.match(text, /[0-9a-f]{64}/, file)
    assert.match(text, /sha256sum -c -/, file)
  }
})
