import { test } from "node:test"
import assert from "node:assert/strict"
import {
  commandKey,
  expandSecretsFile,
  isDirty,
  newestMigrationId,
  parseArgs,
  parseDefaultBranch,
  parseKitRef,
  publishBranch,
  rawCallArgs,
  resolveModule,
  translate,
  validateOptions,
} from "../bin/lib.mjs"

// Real `git ls-tree -r --name-only` output shape.
const TREE = `.gitignore
README.md
fixtures/dotnet-api/src/Infrastructure/Migrations/20260912083112_InitialCreate.cs
fixtures/dotnet-api/src/Infrastructure/Migrations/20260912083112_InitialCreate.Designer.cs
fixtures/dotnet-api/src/Infrastructure/Migrations/AppDbContextModelSnapshot.cs
fixtures/dotnet-api/src/Api/Program.cs`

test("finds the migration id in a repository tree", () => {
  assert.equal(newestMigrationId(TREE), "20260912083112_InitialCreate")
})

test("picks the newest of several migrations", () => {
  const tree = `m/20260101000000_A.cs\nm/20260303000000_C.cs\nm/20260202000000_B.cs`
  assert.equal(newestMigrationId(tree), "20260303000000_C")
})

test("a repository with no migrations yields undefined, not a crash", () => {
  assert.equal(newestMigrationId(`README.md\nsrc/Program.cs`), undefined)
})

test("a git SHA is never mistaken for a migration id", () => {
  // The bug this file exists for: `git merge-base` output was being passed straight to
  // `dotnet ef migrations script`, which answered "the migration was not found".
  assert.equal(newestMigrationId(`aeab9b500e837f21bc0ca47bda2b729d1418f8c2`), undefined)
})

test("the model snapshot is not a migration", () => {
  assert.equal(newestMigrationId(`m/AppDbContextModelSnapshot.cs`), undefined)
})

test("reads the kit pin", () => {
  const yaml = `kit: github.com/taimg1/shipkit@v1.0.0\nstack: dotnet\n`
  assert.equal(parseKitRef(yaml), "github.com/taimg1/shipkit@v1.0.0")
})

test("a fixture with no kit pin uses the local module", () => {
  assert.equal(parseKitRef(`stack: dotnet\nproject: src/Api\n`), undefined)
})

test("an indented kit key belongs to another block and is ignored", () => {
  // Otherwise a nested `kit:` under some future section would silently redirect the module.
  assert.equal(parseKitRef(`environments:\n  prod:\n    kit: nope\n`), undefined)
})

test("a commented-out pin is not read", () => {
  assert.equal(parseKitRef(`# kit: github.com/taimg1/shipkit@v1.0.0\nstack: dotnet\n`), undefined)
})

// --- defaultBranch (#4) ---

test("the diff base branch comes from shipkit.yaml", () => {
  assert.equal(parseDefaultBranch(`service: api\ndefaultBranch: master\n`), "master")
  assert.equal(parseDefaultBranch(`defaultBranch: "prod" # deployed\n`), "prod")
})

test("without defaultBranch the base branch is main, as in the module", () => {
  assert.equal(parseDefaultBranch(`service: api\n`), "main")
})

// --- argument parsing and validation (#2) ---

const ctx = (over: Record<string, unknown> = {}) => ({
  sha: () => "abc1234def",
  branch: () => "dev",
  migrationBase: () => "20260101000000_FromGit",
  dirty: () => false,
  env: {},
  ...over,
})

const argsFor = (argv: string[], c = ctx()) => {
  const opts = parseArgs(argv)
  const key = commandKey(opts._)
  return { opts, key, invalid: validateOptions(key, opts), args: translate(key, opts, c) }
}

test("an explicit --migration-base reaches dagger instead of the git-derived one", () => {
  // The bug: the flag was accepted, dropped, and Dagger returned a cached report.
  const { invalid, args } = argsFor(["ci", "--migration-base=20260914063401_BookingRowVersion"])
  assert.equal(invalid, undefined)
  assert.ok(args.includes("--migration-base=20260914063401_BookingRowVersion"))
  assert.ok(!args.includes("--migration-base=20260101000000_FromGit"))
})

test("--migration-base also works as two arguments", () => {
  const { args } = argsFor(["ci", "--migration-base", "20260914063401_X"])
  assert.ok(args.includes("--migration-base=20260914063401_X"))
})

test("the git base is only computed when the command needs it", () => {
  let calls = 0
  const c = ctx({ migrationBase: () => (calls++, "20260101000000_A") })
  argsFor(["doctor"], c)
  argsFor(["ci", "--migration-base=20260202000000_B"], c)
  assert.equal(calls, 0)
})

test("db lint and db pending diff against the same base as ci", () => {
  assert.ok(argsFor(["db", "lint"]).args.includes("--migration-base=20260101000000_FromGit"))
  assert.ok(argsFor(["db", "pending"]).args.includes("--migration-base=20260101000000_FromGit"))
})

test("an option the command does not take is rejected, not ignored", () => {
  const { invalid } = argsFor(["doctor", "--migration-base=X"])
  assert.equal(invalid?.code, 2)
  assert.match(invalid!.message, /unknown option --migration-base for "shipkit doctor"/)
})

test("a misspelled option is rejected and the real ones are listed", () => {
  const { invalid } = argsFor(["ci", "--migrationbase=X"])
  assert.equal(invalid?.code, 2)
  assert.match(invalid!.message, /--migration-base/)
})

test("a value option without a value is a config error", () => {
  assert.equal(argsFor(["ci", "--stage"]).invalid?.code, 2)
})

test("a bare --yes is a missing confirmation, exit 4", () => {
  assert.equal(argsFor(["deploy", "--yes"]).invalid?.code, 4)
})

test("deploy --plan is built for the same --stage the deploy will run (B7)", () => {
  const plan = argsFor(["deploy", "--plan", "--stage=backup,migrate"]).args
  assert.equal(plan[0], "deploy-plan")
  assert.ok(plan.includes("--stage=backup,migrate"))
  const run = argsFor(["deploy", "--yes=abc", "--stage=backup,migrate"]).args
  assert.ok(run.includes("--stage=backup,migrate"))
  assert.ok(!argsFor(["deploy", "--plan"]).args.some((a: string) => a.startsWith("--stage")))
})

test("deploy names who is running it, for the deploy lock (B13)", () => {
  const args = argsFor(["deploy", "--yes=abc"], ctx({ env: { USER: "alice" } })).args
  assert.ok(args.includes("--actor=alice"))
  const ci = argsFor(["deploy", "--yes=abc"], ctx({ env: { USER: "runner", GITHUB_ACTOR: "bob" } })).args
  assert.ok(ci.includes("--actor=bob"))
  assert.ok(!argsFor(["deploy", "--yes=abc"]).args.some((a: string) => a.startsWith("--actor")))
})

test("a flag never swallows the command after it", () => {
  const opts = parseArgs(["--json", "ci"])
  assert.equal(opts.json, true)
  assert.deepEqual(opts._, ["ci"])
})

test("a flag given a value is rejected", () => {
  assert.equal(argsFor(["ci", "--json=yes"]).invalid?.code, 2)
})

test("db subcommands are one command key", () => {
  assert.equal(commandKey(["db", "lint"]), "db lint")
  assert.equal(commandKey(["rollback", "sha-abc1234"]), "rollback")
})

// --- --raw and the module (#3, #7) ---

test("options before --raw are kept, everything after is Dagger's", () => {
  const opts = parseArgs(["--module", "github.com/x/shipkit@abc", "--raw", "ci", "--source=.", "--stage=pre"])
  assert.equal(opts.module, "github.com/x/shipkit@abc")
  assert.deepEqual(opts.raw, ["ci", "--source=.", "--stage=pre"])
})

test("--raw calls the resolved module", () => {
  assert.deepEqual(rawCallArgs(["ci", "--source=."], "github.com/x/shipkit@abc"), [
    "call", "-m", "github.com/x/shipkit@abc", "ci", "--source=.",
  ])
})

test("--raw leaves a module named in the raw args alone", () => {
  assert.deepEqual(rawCallArgs(["-m", "./other", "ci"], "github.com/x/shipkit@abc"), ["call", "-m", "./other", "ci"])
})

test("module order: --module, then SHIPKIT_MODULE, then kit:", () => {
  const yamlText = "kit: from-yaml\n"
  assert.equal(resolveModule({ option: "opt", envVar: "env", yamlText }).ref, "opt")
  assert.equal(resolveModule({ envVar: "env", yamlText }).ref, "env")
  assert.equal(resolveModule({ yamlText }).ref, "from-yaml")
})

test("inside the shipkit repository the local module is used", () => {
  const r = resolveModule({ yamlText: "stack: dotnet\n", localModule: "shipkit" })
  assert.equal(r.ref, undefined)
  assert.equal(r.error, undefined)
})

test("a client project without a kit pin gets a config error, not a Dagger one", () => {
  const r = resolveModule({ yamlText: "stack: dotnet\n", localModule: undefined })
  assert.match(r.error!, /kit: github.com\/taimg1\/shipkit@<commit>/)
})

test("another project's dagger module is not mistaken for shipkit", () => {
  assert.ok(resolveModule({ yamlText: "stack: dotnet\n", localModule: "something-else" }).error)
})

// --- dirty working tree (#6) ---

test("uncommitted changes make the tree dirty", () => {
  assert.equal(isDirty(" M Api/Program.cs\n?? Api/Dockerfile\n"), true)
})

test("a clean tree is not dirty", () => {
  assert.equal(isDirty(""), false)
})

test("the tool's own run log does not make the tree dirty", () => {
  assert.equal(isDirty("?? .shipkit/runs/2026-09-14-abc.json\n"), false)
  assert.equal(isDirty("?? fixtures/dotnet-api/.shipkit/runs/x.json\n"), false)
})

test("a renamed file counts by its new path", () => {
  assert.equal(isDirty("R  old.cs -> Api/New.cs\n"), true)
})

test("ci tells the module when the tree is dirty", () => {
  assert.ok(argsFor(["ci"], ctx({ dirty: () => true })).args.includes("--dirty"))
  assert.ok(!argsFor(["ci"]).args.includes("--dirty"))
})

// #19: Kamal's own secrets file holds references to environment variables, and the container the
// kit runs Kamal in has none of them. Every reference resolved to empty and the deploy continued.
test("resolves the references in .kamal/secrets from the environment", () => {
  const file = "POSTGRES_PASSWORD=$POSTGRES_PASSWORD\nConnectionStrings__Default=$ConnectionStrings__Default\n"
  const r = expandSecretsFile(file, {
    POSTGRES_PASSWORD: "s3cret",
    ConnectionStrings__Default: "Host=db;Password=s3cret",
  })
  assert.equal(r.missing, undefined)
  assert.equal(r.content, "POSTGRES_PASSWORD=s3cret\nConnectionStrings__Default=Host=db;Password=s3cret\n")
})

// The failure this exists to prevent: an empty value is not a value.
test("a reference with nothing behind it is refused, not expanded to nothing", () => {
  const r = expandSecretsFile("POSTGRES_PASSWORD=$POSTGRES_PASSWORD\nOTHER=$OTHER\n", { OTHER: "x" })
  assert.deepEqual(r.missing, ["POSTGRES_PASSWORD"])
  assert.equal(r.content, undefined)
})

test("an empty string counts as missing", () => {
  assert.deepEqual(expandSecretsFile("A=$A\n", { A: "" }).missing, ["A"])
})

test("every missing name is named, not just the first", () => {
  assert.deepEqual(expandSecretsFile("A=$A\nB=$B\n", {}).missing, ["A", "B"])
})

// The kit injects this one as a Dagger secret; resolving it here would copy the registry token
// into a file for no reason.
test("the registry password stays a reference", () => {
  const r = expandSecretsFile("KAMAL_REGISTRY_PASSWORD=$KAMAL_REGISTRY_PASSWORD\n", {})
  assert.equal(r.missing, undefined)
  assert.match(r.content, /^KAMAL_REGISTRY_PASSWORD=\$KAMAL_REGISTRY_PASSWORD$/m)
})

test("comments, blank lines and literal values are left alone", () => {
  const file = "# a note\n\nLITERAL=kept-as-is\nREF=$REF\n"
  const r = expandSecretsFile(file, { REF: "resolved" })
  assert.match(r.content, /^# a note$/m)
  assert.match(r.content, /^LITERAL=kept-as-is$/m)
  assert.match(r.content, /^REF=resolved$/m)
})

test("${BRACED} references resolve too", () => {
  assert.equal(expandSecretsFile("A=${A}\n", { A: "v" }).content, "A=v\n")
})

// --- which branch ci names for the publish decision (C10) ---

const GH = { GITHUB_ACTIONS: "true" }
const gitSays = (name: string | undefined) => () => name

test("on GitHub a push names the branch it pushed to", () => {
  const env = { ...GH, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" }
  assert.equal(publishBranch(env, undefined, gitSays("whatever")), "main")
})

// The bug: GITHUB_HEAD_REF is the pull request author's branch name. A fork's branch called
// `main` was reported as `main` and passed the module's publish check.
test("a pull request from a branch called main is never reported as main", () => {
  const env = {
    ...GH,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "main",
  }
  const branch = publishBranch(env, undefined, gitSays("main"))
  assert.equal(branch, "pull_request:refs/pull/7/merge")
  assert.notEqual(branch, "main")
})

test("on a pull request an explicit --branch cannot claim the default branch either", () => {
  const env = { ...GH, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" }
  assert.equal(publishBranch(env, "main", gitSays("main")), "pull_request:refs/pull/7/merge")
})

test("events other than push never name a branch, even on the default one", () => {
  for (const event of ["workflow_dispatch", "schedule", "pull_request_target"]) {
    const env = { ...GH, GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main" }
    assert.equal(publishBranch(env, undefined, gitSays("main")), `${event}:refs/heads/main`)
  }
})

test("a tag push is not a branch", () => {
  const env = { ...GH, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.0.0" }
  assert.equal(publishBranch(env, undefined, gitSays("main")), "push:refs/tags/v1.0.0")
})

test("on GitHub with no event at all, nothing looks like a branch", () => {
  assert.equal(publishBranch(GH, undefined, gitSays("main")), "unknown-event:unknown-ref")
})

test("outside GitHub: --branch, else git, else unknown", () => {
  assert.equal(publishBranch({}, "release", gitSays("main")), "release")
  assert.equal(publishBranch({}, undefined, gitSays("main")), "main")
  assert.equal(publishBranch({}, undefined, gitSays(undefined)), undefined)
})

test("GITHUB_HEAD_REF outside a GitHub run is ignored too", () => {
  assert.equal(publishBranch({ GITHUB_HEAD_REF: "main" }, undefined, gitSays("feature")), "feature")
})

test("ci passes the event-derived branch to the module on a pull request", () => {
  const env = { ...GH, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge", GITHUB_HEAD_REF: "main" }
  const { args } = argsFor(["ci"], ctx({ env, branch: () => "main" }))
  assert.ok(args.includes("--branch=pull_request:refs/pull/7/merge"), args.join(" "))
  assert.ok(!args.includes("--branch=main"))
})

test("ci passes no --branch when none is known, so the module refuses to publish", () => {
  const { args } = argsFor(["ci"], ctx({ branch: () => undefined }))
  assert.ok(!args.some((a: string) => a.startsWith("--branch")), args.join(" "))
})

test("summary takes --jobs", () => {
  assert.equal(argsFor(["summary", "reports", "--jobs", "needs.json"]).invalid, undefined)
})
