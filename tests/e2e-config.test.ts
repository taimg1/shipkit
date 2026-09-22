import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  APP_NAME,
  BASE_URL_VAR,
  DEFAULT_E2E_TIMEOUT,
  FLOATING_TAGS,
  MAX_E2E_TIMEOUT,
  parseE2e,
} from "../.dagger/src/e2e-config.ts"

/**
 * The rules that decide what the browser tests run against, checked without Dagger.
 *
 * Two of them are the point of the block and are tested hardest: a moving image tag, which
 * would make one commit mean different runs, and a seed the project has to name, because an
 * empty database answers 200 with empty pages and that is a green test of a broken one.
 */

const DIGEST = "@sha256:" + "a".repeat(64)
const IMAGE = `mcr.microsoft.com/playwright:v1.63.0-noble${DIGEST}`

const block = (over: Record<string, unknown> = {}) => ({
  command: "npx --no-install playwright test",
  image: IMAGE,
  port: 3000,
  ready: "/api/health",
  ...over,
})

const ok = (raw: unknown) => {
  const r = parseE2e(raw)
  assert.equal(r.ok, true, r.ok ? "" : r.message)
  return r.ok ? r.e2e : null
}

const refused = (raw: unknown) => {
  const r = parseE2e(raw)
  assert.equal(r.ok, false, "accepted something it should refuse")
  return r.ok ? "" : r.message
}

test("no block means no stage, not an error", () => {
  assert.equal(ok(undefined), null)
  assert.equal(ok(null), null)
})

// `services` absent is a supported shape, not an oversight: a suite that checks layout,
// overflow, broken images and the console needs nothing running but the site.
test("a minimal block parses with no services, and timeout defaults", () => {
  const e2e = ok(block())
  assert.equal(e2e?.command, "npx --no-install playwright test")
  assert.equal(e2e?.port, 3000)
  assert.equal(e2e?.ready, "/api/health")
  assert.equal(e2e?.timeout, DEFAULT_E2E_TIMEOUT)
  assert.deepEqual(e2e?.services, [])
  assert.deepEqual(e2e?.env, {})
})

test("every field the stage cannot invent is required", () => {
  assert.match(refused(block({ command: undefined })), /command is required/)
  assert.match(refused(block({ image: undefined })), /image is required/)
  assert.match(refused(block({ port: undefined })), /port is required/)
  assert.match(refused(block({ ready: undefined })), /ready is required/)
  assert.match(refused(block({ ready: "api/health" })), /absolute path/)
})

// The URL is the kit's to hand over, under one fixed name. A project that set it could point
// the suite at a developer's localhost and pass while the built image was never started.
test("the project may not set the base URL variable itself", () => {
  assert.match(refused(block({ env: { [BASE_URL_VAR]: "http://localhost:3000" } })), /must not set E2E_BASE_URL/)
})

test("the command is one line: a second one would run after the tests unnoticed", () => {
  assert.match(refused(block({ command: "npx playwright test\nrm -rf /" })), /single command line/)
})

// core/images.ts pins every image the kit runs, for exactly this reason. A digest is better
// than a tag and both are accepted; a name that moves is not.
test("the browsers image names a version", () => {
  assert.equal(ok(block({ image: "mcr.microsoft.com/playwright:v1.63.0-noble" }))?.image.endsWith("-noble"), true)
  assert.match(refused(block({ image: "mcr.microsoft.com/playwright" })), /has no tag/)
  assert.match(refused(block({ image: "mcr.microsoft.com/playwright:latest" })), /which moves/)
})

test("timeout is bounded and whole", () => {
  assert.equal(ok(block({ timeout: 90 }))?.timeout, 90)
  assert.match(refused(block({ timeout: 0 })), /between 1 and/)
  assert.match(refused(block({ timeout: MAX_E2E_TIMEOUT + 1 })), /between 1 and/)
  assert.match(refused(block({ timeout: "600" })), /between 1 and/)
})

test("port is a port", () => {
  assert.match(refused(block({ port: 0 })), /must be a port number/)
  assert.match(refused(block({ port: 70000 })), /must be a port number/)
  assert.match(refused(block({ port: "3000" })), /must be a port number/)
})

const svc = (over: Record<string, unknown> = {}) => ({
  name: "db",
  image: "postgres:17-alpine",
  port: 5432,
  ...over,
})

test("a declared service parses, with its env and its seed", () => {
  const e2e = ok(block({ services: [svc({ env: { POSTGRES_PASSWORD: "postgres" }, initSql: "ci/e2e-seed.sql" })] }))
  assert.deepEqual(e2e?.services, [
    {
      name: "db",
      image: "postgres:17-alpine",
      port: 5432,
      env: { POSTGRES_PASSWORD: "postgres" },
      ready: undefined,
      initSql: "ci/e2e-seed.sql",
      fromHealth: undefined,
    },
  ])
})

// The rule this block exists to state: a tag somebody else can move makes one commit mean two
// different runs, and the kit does not do that quietly.
test("a service image must name a version, and never a tag that moves", () => {
  assert.match(refused(block({ services: [svc({ image: "postgres" })] })), /has no tag/)
  for (const tag of FLOATING_TAGS) {
    assert.match(refused(block({ services: [svc({ image: `postgres:${tag}` })] })), /which moves/)
  }
  // A digest settles it whatever the tag says: that reference cannot move.
  assert.equal(ok(block({ services: [svc({ image: `postgres:latest${DIGEST}` })] }))?.services[0].image.endsWith(DIGEST), true)
})

test("a registry port is not a tag", () => {
  assert.match(refused(block({ services: [svc({ image: "localhost:5000/db" })] })), /has no tag/)
  assert.equal(ok(block({ services: [svc({ image: "localhost:5000/db:2.1" })] }))?.services[0].port, 5432)
})

test("service names are hostnames, unique, and never the app's", () => {
  assert.match(refused(block({ services: [svc({ name: "My DB" })] })), /hostname label/)
  assert.match(refused(block({ services: [svc(), svc()] })), /declared twice/)
  assert.match(refused(block({ services: [svc({ name: APP_NAME })] })), new RegExp(`cannot be "${APP_NAME}"`))
})

// A database has no HTTP path, so `ready` cannot be required of every service — absent, the
// core falls back to a TCP connect, which is all it can honestly check for a protocol it does
// not know (ADR 0008).
test("a ready path is a path; leaving it out is allowed and means a TCP check", () => {
  assert.match(refused(block({ services: [svc({ ready: "healthz" })] })), /absolute path/)
  assert.equal(ok(block({ services: [svc({ ready: "/healthz" })] }))?.services[0].ready, "/healthz")
  assert.equal(ok(block({ services: [svc()] }))?.services[0].ready, undefined)
})

test("the seed is a file inside the repository", () => {
  assert.match(refused(block({ services: [svc({ initSql: "/etc/passwd" })] })), /file in the repository/)
  assert.match(refused(block({ services: [svc({ initSql: "../../secrets.sql" })] })), /file in the repository/)
})

// Parsed so a project can be written against the shape; refused by core/e2e.ts with exit 5
// until it is built, never with a fallback to a moving tag.
test("fromHealth is accepted only in place of a tag", () => {
  const resolved = ok(block({ services: [svc({ image: "ghcr.io/org/api", fromHealth: "https://api.example.com/health" })] }))
  assert.equal(resolved?.services[0].fromHealth, "https://api.example.com/health")
  assert.match(
    refused(block({ services: [svc({ image: "ghcr.io/org/api:1.2.3", fromHealth: "https://api.example.com/health" })] })),
    /carries a tag and .* would resolve one/,
  )
  assert.match(
    refused(block({ services: [svc({ image: "ghcr.io/org/api", fromHealth: "api.example.com/health" })] })),
    /must be an http\(s\) URL/,
  )
})

test("env values are written out, and a mapping has no sensible text", () => {
  assert.deepEqual(ok(block({ services: [svc({ env: { PORT: 5432, DEBUG: true } })] }))?.services[0].env, {
    PORT: "5432",
    DEBUG: "true",
  })
  assert.match(refused(block({ services: [svc({ env: { A: { b: 1 } } })] })), /must be a value/)
  assert.match(refused(block({ services: [svc({ env: { "2BAD": "x" } })] })), /environment variable name/)
})

test("the shapes that are not a block at all", () => {
  assert.match(refused("npx playwright test"), /must be a mapping/)
  assert.match(refused(block({ services: {} })), /must be a list/)
  assert.match(refused(block({ services: ["db"] })), /must be a mapping/)
})

// The fixture is the kit's proof that this parses something real, not only something invented
// in a test. The block is read as text — the tests deliberately have no YAML parser — and fed
// through the same rules, so a fixture that stopped being a valid configuration fails here.
test("the next fixture's own e2e block parses", () => {
  const yaml = readFileSync(new URL("../fixtures/next-app/shipkit.yaml", import.meta.url), "utf8")
  const field = (name: string) => new RegExp(`^  ${name}:\\s*(\\S+)$`, "m").exec(yaml)?.[1]

  const e2e = ok({
    command: /^  command:\s*(.+)$/m.exec(yaml)?.[1],
    image: field("image"),
    port: Number(field("port")),
    ready: field("ready"),
    timeout: Number(field("timeout")),
  })
  assert.ok(e2e, "the fixture configures no e2e block")
  // Digest-pinned, because the fixture is what a client project copies.
  assert.match(e2e!.image, /@sha256:[0-9a-f]{64}$/)
  assert.match(e2e!.command, /playwright/)
})
