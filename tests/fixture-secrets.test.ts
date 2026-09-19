import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { declaredSecrets, missingSecrets } from "../.dagger/src/core/kamal-config.ts"
import { expandSecretsFile } from "../bin/lib.mjs"

// The fixture is the template a client project copies. What it does with credentials is what
// every client deployment will do with them.
const root = new URL("../fixtures/dotnet-api/", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")

test("no password is committed in clear configuration", () => {
  const deployYml = read("config/deploy.yml")
  assert.doesNotMatch(deployYml, /Password=/i)
  assert.ok(declaredSecrets(deployYml).includes("ConnectionStrings__Default"))
})

test("every declared secret in .kamal/secrets is a reference, not a value", () => {
  const secrets = read(".kamal/secrets")
  const declared = declaredSecrets(read("config/deploy.yml"))
  assert.deepEqual(missingSecrets(declared, secrets).sort(), [...declared].sort())
})

test("with the variables exported, every declared secret resolves", () => {
  const env = {
    POSTGRES_PASSWORD: "owner-pw",
    APP_DB_PASSWORD: "app-pw",
    APP_DATABASE_URL: "Host=shipkit-fixture-db;Database=app;Username=app;Password=app-pw",
  }
  const resolved = expandSecretsFile(read(".kamal/secrets"), env)
  assert.equal(resolved.missing, undefined)
  assert.deepEqual(missingSecrets(declaredSecrets(read("config/deploy.yml")), resolved.content), [])
  assert.match(resolved.content, /^ConnectionStrings__Default=.*Username=app;/m)
})

test("secrets and delivery config stay out of the Docker build context", () => {
  const ignored = read(".dockerignore").split("\n").map((l) => l.trim())
  for (const pattern of [".kamal/", ".env", ".env.*", "*.pem", "*.key", "config/deploy*.yml"]) {
    assert.ok(ignored.includes(pattern), `.dockerignore does not exclude ${pattern}`)
  }
})

test("the app-role init script is valid sh and refuses to run without a password", () => {
  const path = new URL("config/postgres/create-app-role.sh", root).pathname
  assert.equal(spawnSync("sh", ["-n", path]).status, 0)
  // No psql on PATH: if the guard failed, the script would get as far as calling it.
  const r = spawnSync("/bin/sh", [path], { encoding: "utf8", env: { PATH: "/nonexistent" } })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /APP_DB_PASSWORD must be set/)
})
