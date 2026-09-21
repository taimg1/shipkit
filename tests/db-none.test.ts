import { test } from "node:test"
import assert from "node:assert/strict"
import type { Config } from "../.dagger/src/config.ts"
import type { DeployPlan } from "../.dagger/src/core/plan-token.ts"
import { configProblem } from "../.dagger/src/config-validate.ts"
import { autoApproveRefusal } from "../.dagger/src/core/auto-approve.ts"
import { DEFAULT_VERIFY_TIMEOUT, judge, verifySettings } from "../.dagger/src/core/health.ts"
import { digest, planToken, renderPlan } from "../.dagger/src/core/plan-token.ts"
import { provisioning, type ServerState } from "../.dagger/src/core/server-probe.ts"
import { deployStageProblem, deployStageSkip, parseStages } from "../.dagger/src/core/stage-select.ts"

/**
 * The deploy path over the two project shapes the kit has to serve: a .NET project with a
 * PostgreSQL database, and a Next.js site with none.
 *
 * Every rule below is asserted over BOTH shapes in the same test, on purpose. The failure this
 * file exists to catch is not "db: none is broken" — the deploy simply died in its first stage
 * — it is a later change making "no database" quietly mean "no gates". A rule that stops
 * firing for the database shape fails on the line next to the one it was relaxed for.
 */

const environment = {
  url: "https://app.client.com",
  host: "10.0.0.5",
  sshPort: 22,
  sshUser: "deploy",
  dbContainer: "client-api-db",
  network: "kamal",
  database: "app",
  dbUser: "postgres",
}

/** The shape v1 was written for. Every gate applies to it, before this change and after it. */
const DOTNET_POSTGRES: Config = {
  stack: "dotnet",
  db: "postgres",
  delivery: "kamal",
  health: "/health",
  ready: "/health/ready",
  verifyTimeout: DEFAULT_VERIFY_TIMEOUT,
  project: "src/Api",
  dockerfile: "Dockerfile",
  registry: "ghcr.io/client/api",
  service: "client-api",
  defaultBranch: "main",
  publish: true,
  stackVersion: "10.0",
  targetArch: "linux-x64",
  backupRetention: 10,
  environments: { prod: environment },
  migrationTimeouts: { lockTimeout: "5s", statementTimeout: "15min" },
}

/**
 * The real consumer: an SSR Next.js site (`output: 'standalone'`) delivered by Kamal, with no
 * database at all — so no `ready` path either, because there is no dependency for readiness to
 * prove (docs/multi-stack-plan.md §6).
 */
const NEXT_NONE: Config = {
  ...DOTNET_POSTGRES,
  stack: "next",
  db: "none",
  ready: undefined,
  project: ".",
  registry: "ghcr.io/client/site",
  service: "client-site",
  environments: { prod: { ...environment, dbContainer: undefined } },
}

/**
 * What the deploy calls this project's database (index.ts). An adapter that implements none is
 * the same absence as `db: none`, and the deploy reads one value rather than asking twice.
 */
const dbKind = (cfg: Config, adapterHasDb: boolean) => (adapterHasDb ? cfg.db : "none")
const POSTGRES = dbKind(DOTNET_POSTGRES, true)
const NONE = dbKind(NEXT_NONE, false)

/** As index.ts declares them. */
const DEPLOY = ["provision", "backup", "migrate", "release", "verify", "rollback", "clean"]
const sel = (spec?: string) => parseStages(spec, DEPLOY)

test("both project shapes are configurations the kit accepts", () => {
  assert.equal(configProblem(DOTNET_POSTGRES), null)
  assert.equal(configProblem(NEXT_NONE), null)
})

test("a stack with no database adapter reads as db=none whatever shipkit.yaml says", () => {
  // The contradictory case — `db: postgres` on a stack that has no migrations — must not leave
  // the deploy trying to dump a database nothing in the pipeline knows how to migrate.
  assert.equal(dbKind(DOTNET_POSTGRES, false), "none")
})

test("backup and migrate run with a database and are skipped, visibly, without one", () => {
  for (const name of ["backup", "migrate"]) {
    assert.equal(deployStageSkip(sel(), name, POSTGRES), null, name)
    // Not omitted: the report carries the stage with the reason it did not run (ADR 0004).
    assert.equal(deployStageSkip(sel(), name, NONE), "db=none", name)
  }
})

test("every other deploy stage runs for both shapes", () => {
  for (const name of ["provision", "release", "verify", "rollback", "clean"]) {
    assert.equal(deployStageSkip(sel(), name, POSTGRES), null, name)
    assert.equal(deployStageSkip(sel(), name, NONE), null, name)
  }
})

test("a stage nobody asked for says so rather than blaming the database", () => {
  const some = sel("release,verify")
  assert.equal(deployStageSkip(some, "backup", POSTGRES), "not selected")
  assert.equal(deployStageSkip(some, "backup", NONE), "not selected")
  assert.equal(deployStageSkip(some, "release", NONE), null)
})

test("the stage-set gates do not weaken for a project with no database", () => {
  // Not a database rule: it fires for both shapes, and it is what leaves a failed release with
  // something to roll it back.
  assert.match(deployStageProblem(sel("release"), 0) ?? "", /without verify/)
  assert.match(deployStageProblem(sel("provision,backup,migrate,release,clean"), 0) ?? "", /without verify/)

  // The two migration rules are about migrations that are pending, which a db=none project
  // never has — and neither does a database project with nothing to apply.
  assert.equal(deployStageProblem(sel("release,verify"), 0), null)
  assert.equal(deployStageProblem(sel("migrate,release,verify"), 0), null)

  // And both still fire the moment there is something to apply, which is the whole point.
  assert.match(deployStageProblem(sel("release,verify"), 2) ?? "", /without migrate while 2/)
  assert.match(deployStageProblem(sel("migrate,release,verify"), 2) ?? "", /without backup/)
})

const AMD64 = "linux/amd64"
const server = (over: Partial<ServerState> = {}): ServerState => ({
  docker: "ok",
  proxy: "running",
  db: "running",
  appContainers: 2,
  arch: AMD64,
  archRaw: "x86_64",
  ...over,
})

test("a project with no database is never offered a database accessory", () => {
  const fresh = server({ proxy: "missing", db: "missing", appContainers: 0 })
  const withDb = provisioning(fresh, true, AMD64)
  assert.ok(withDb.ok && withDb.steps.some((s) => s.startsWith("boot the database")))

  const withoutDb = provisioning(fresh, false, AMD64)
  // The proxy is still provisioned: it is how Kamal serves anything, database or not.
  assert.deepEqual(withoutDb, {
    ok: true,
    steps: ["start kamal-proxy (Kamal does this as part of the release)"],
  })
})

test("a stopped database stops a deploy that needs one and is ignored by one that does not", () => {
  assert.equal(provisioning(server({ db: "stopped" }), true, AMD64).ok, false)
  assert.deepEqual(provisioning(server({ db: "stopped" }), false, AMD64), { ok: true, steps: [] })

  // The refusals that are not about the database keep refusing both.
  assert.equal(provisioning(server({ arch: null, archRaw: "" }), false, AMD64).ok, false)
  assert.equal(provisioning(server(), false, "linux/arm64").ok, false)
})

test("verify demands readiness where there is a database and invents none where there is not", () => {
  // Unchanged for the database shape: no `ready` in shipkit.yaml is a config error, because
  // /health touches nothing and a release with a dead database passes it (C4).
  assert.equal(verifySettings({}, DOTNET_POSTGRES.db).ok, false)
  assert.deepEqual(verifySettings({ ready: DOTNET_POSTGRES.ready }, DOTNET_POSTGRES.db), {
    ok: true,
    ready: "/health/ready",
    verifyTimeout: DEFAULT_VERIFY_TIMEOUT,
  })

  // With no database there is nothing for readiness to prove, so it is optional — and absent
  // rather than guessed: a default path would either 404 everywhere or hit something that
  // always answers 200.
  assert.deepEqual(verifySettings({}, NEXT_NONE.db), {
    ok: true,
    ready: undefined,
    verifyTimeout: DEFAULT_VERIFY_TIMEOUT,
  })
})

test("gate 4 still checks the deployed SHA when there is no readiness path", () => {
  const ok = (version: string) => ({
    health: { status: 200, body: JSON.stringify({ status: "ok", version }) },
    ready: null,
  })
  assert.equal(judge(ok("a1b2c3d"), (v) => v === "a1b2c3d").ok, true)
  // A 200 from the previous container is the failure the gate exists for, with or without a
  // database behind it.
  assert.equal(judge(ok("9f8e7d6"), (v) => v === "a1b2c3d").ok, false)
  assert.equal(judge({ health: { status: 200, body: "ok" }, ready: null }, () => true).ok, false)
})

/** A merge to main on the .NET project: published image, previous release running, one migration. */
const dotnetPlan: DeployPlan = {
  env: "prod",
  url: DOTNET_POSTGRES.environments.prod.url,
  imageTag: "sha-a1b2c3d",
  currentImageTag: "sha-9f8e7d6",
  servingVersion: "9f8e7d6",
  provision: [],
  hasDb: true,
  migrations: ["20260911_AddOrdersIndex"],
  sqlDigest: digest("CREATE INDEX CONCURRENTLY"),
  sqlPreview: "12 lines",
  destructive: false,
  allowLoss: [],
  imageDigest: "sha256:" + "a".repeat(64),
  lastVerifiedBackup: "client-api-20260910T030012Z.pgc",
  stages: null,
  token: "0123456789ab",
}

/** The same merge on the Next.js site: no migrations, no backup, no schema. */
const nextPlan: DeployPlan = {
  ...dotnetPlan,
  url: NEXT_NONE.environments.prod.url,
  hasDb: false,
  migrations: [],
  sqlDigest: digest(""),
  sqlPreview: "no schema change",
  lastVerifiedBackup: null,
}

const shapes: [string, DeployPlan][] = [
  ["dotnet+postgres", dotnetPlan],
  ["next+none", nextPlan],
]

test("a boring deploy approves itself in both shapes", () => {
  for (const [name, p] of shapes) assert.equal(autoApproveRefusal(p), null, name)
})

test("every reason to stop still stops a project with no database", () => {
  const reasons: [string, Partial<DeployPlan>, RegExp][] = [
    ["provisioning", { provision: ["boot the database accessory (first deploy to this server)"] }, /change the server first/],
    ["no published image", { imageDigest: null }, /no image is published/],
    ["a first deploy", { currentImageTag: null }, /nothing to roll back to/],
    ["a stage selection", { stages: ["release", "verify"] }, /only part of the deploy/],
    // Neither can arise from an empty migration list, and neither is allowed to be read off
    // one: a policy that infers "no database, so nothing destructive" is a policy that stops
    // reading the plan.
    ["destructive SQL", { destructive: true }, /destructive SQL/],
    ["a waived loss", { allowLoss: ["orders.CreatedAt"] }, /waive data loss/],
  ]
  for (const [why, over, expected] of reasons) {
    for (const [name, p] of shapes) {
      assert.match(autoApproveRefusal({ ...p, ...over }) ?? "", expected, `${name}: ${why}`)
    }
  }
})

test("the plan shows database lines only to a project that has a database", () => {
  const withDb = renderPlan(dotnetPlan)
  assert.match(withDb, /^ {2}migrations {2}20260911_AddOrdersIndex$/m)
  assert.match(withDb, /^ {2}sql {9}12 lines$/m)
  assert.match(withDb, /^ {2}backup {6}will run first/m)

  const withoutDb = renderPlan(nextPlan)
  assert.doesNotMatch(withoutDb, /^ {2}migrations /m)
  assert.doesNotMatch(withoutDb, /^ {2}sql /m)
  assert.doesNotMatch(withoutDb, /^ {2}backup /m)
  // Said, not left out: the reader is told which stages will not run, and why (ADR 0004).
  assert.match(withoutDb, /^ {2}database {4}none {2}\(backup and migrate are skipped\)$/m)

  // Everything that is not about a database is the same plan in both.
  for (const text of [withDb, withoutDb]) {
    assert.match(text, /^ {2}target {6}prod/m)
    assert.match(text, /^ {2}image {7}sha-a1b2c3d {2}<- {2}currently sha-9f8e7d6/m)
    assert.match(text, /to execute: shipkit deploy --yes=0123456789ab$/m)
  }
})

test("a plan that skips the backup is not the plan that takes one", () => {
  // Same project, same commit, nothing pending on either side: without hasDb in the token these
  // two hash identically, and a token shown for the deploy that dumps production first would
  // execute the deploy that does not.
  const { token: _, ...base } = nextPlan
  assert.notEqual(planToken({ ...base, hasDb: true }), planToken({ ...base, hasDb: false }))
})

test("a plan that does not say whether it has a database is read as one that has", () => {
  // Fail closed in the direction that shows more: an older plan object reaching either
  // function must not be the one that hides the backup.
  const { token: _, hasDb: __, ...legacy } = nextPlan
  assert.equal(planToken(legacy as never), planToken({ ...legacy, hasDb: true } as never))
  assert.match(renderPlan({ ...legacy, token: "0123456789ab" } as never), /^ {2}backup /m)
})
