import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/**
 * What a client repository copies: one job per stage, a composite action they all use, and a
 * summary. The files are YAML that nothing in this repository executes, so these are the only
 * thing standing between a template and a client discovering the mistake on their own runner.
 */
const WITH_DB = "templates/github/ci.yml"
const NO_DB = "templates/github/ci-no-db.yml"
const SETUP = "templates/github/actions/setup/action.yml"
const WORKFLOWS = [WITH_DB, NO_DB]

/** Lines that do something. Comments differ between the two variants on purpose. */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"))

/** Job id -> its lines, by indentation: a job header is the only thing two spaces deep. */
function jobs(file: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of code(file).slice(code(file).indexOf("jobs:") + 1)) {
    const header = /^ {2}([a-z][\w-]*):$/.exec(line)
    if (header) out.set(header[1], (current = []))
    else current?.push(line)
  }
  return out
}

/** Every command a job runs: the one-line form, and each line of a `run: |` block. */
function runLines(block: string[]): string[] {
  const out: string[] = []
  for (const [i, line] of block.entries()) {
    const step = /^(\s*)(- )?run: (.*)$/.exec(line)
    if (!step) continue
    const [, indent, dash, first] = step
    if (first !== "|") {
      out.push(first.trim())
      continue
    }
    const depth = indent.length + (dash ? 2 : 0)
    for (const next of block.slice(i + 1)) {
      if (next.length - next.trimStart().length <= depth) break
      out.push(next.trim())
    }
  }
  return out
}

/**
 * ADR 0001, as amended: the rule is per job now, and it is still "a checkout and one call".
 * Anything else in a `run:` is pipeline logic that moved into YAML, which is the leak this
 * whole layering exists to prevent.
 *
 * Three shapes of shell are allowed beside the wrapper, and none of them decides anything:
 * writing `$NEEDS` to a file, writing the deploy key to a file, and handing the wrapper's own
 * JSON to the GitHub API. The negative test below is the real guard — it is what would catch a
 * `dagger call`, a `kamal deploy` or an `ssh` appearing here.
 */
const PLUMBING = [
  /^set -euo pipefail$/,
  /^printf '%s' "\$NEEDS" > /,
  /^test -n "\$SHIPKIT_SSH_KEY" \|\| /,
  /^install -m 600 \/dev\/null /,
  /^printf '%s\\n' "\$SHIPKIT_SSH_KEY" > /,
  /^id=\$\(gh api "repos\/\$GITHUB_REPOSITORY\/deployments" --input /,
  /^gh api --silent "repos\/\$GITHUB_REPOSITORY\/deployments\/\$id\/statuses" --input /,
]

test("every job runs the wrapper, and what is not the wrapper is plumbing", () => {
  for (const file of WORKFLOWS) {
    for (const [name, block] of jobs(file)) {
      for (const line of runLines(block)) {
        const wrapper = /^node "\$SHIPKIT" (ci --stage=|summary reports |deploy --auto )/.test(line)
        assert.ok(
          wrapper || PLUMBING.some((shape) => shape.test(line)),
          `${file}: job ${name} runs something that is neither the wrapper nor known plumbing: ${line}`,
        )
      }
    }
  }
})

// The leak this whole layering exists to prevent, stated as the thing it would look like.
// Every one of these is a decision about how the pipeline runs, and every one of them belongs
// in the Dagger module — a client on Gitea or GitLab rewrites this file and keeps the pipeline.
test("no job reaches past the wrapper into the pipeline or the server", () => {
  for (const file of WORKFLOWS) {
    for (const [name, block] of jobs(file)) {
      for (const line of runLines(block)) {
        for (const leak of [/\bdagger\b/, /\bkamal\b/, /\bdocker\b/, /\bssh\b/, /\bpsql\b/, /\bpg_dump\b/]) {
          assert.ok(!leak.test(line), `${file}: job ${name} runs the pipeline itself: ${line}`)
        }
      }
    }
  }
})

test("one job per stage, and the summary knows about all of them", () => {
  const stages = (file: string) =>
    code(file)
      .map((l) => /--stage=(\S+)/.exec(l)?.[1])
      .filter((s): s is string => s !== undefined)

  // `e2e` is selected with `build` because it serves the container that stage produced, in
  // memory — the same reason `push` is (below).
  assert.deepEqual(stages(WITH_DB), ["pre", "test", "build,e2e", "db", "build,push"])
  assert.deepEqual(stages(NO_DB), ["pre", "test", "build,e2e", "build,push"])

})

/**
 * Where `e2e` sits in the graph, which is the whole of what this file decides about it.
 *
 * After the image, because the stage needs one and a browser run on a commit whose image does
 * not build is minutes spent to learn what `build` says in seconds. Before the deploy, because a
 * suite that reports after the release has already let the version it disagrees with serve —
 * that is a report, not a gate (ADR 0004: a gate that does not stop anything is not a gate).
 */
test("e2e runs on the built image and the deploy waits for it", () => {
  for (const file of WORKFLOWS) {
    const all = jobs(file)
    const e2e = all.get("e2e")!
    // `build,e2e`, not `e2e`: the image lives in the Dagger engine, and Actions cannot hand a
    // container from one job to another — the stage rebuilds it, which the cache makes cheap.
    assert.deepEqual(runLines(e2e), ['node "$SHIPKIT" ci --stage=build,e2e --report=reports/e2e.json'], file)
    // The image job waits for e2e, so a suite that fails publishes nothing, and the deploy
    // waits for the image: a browser run that reports after the release is not a gate.
    const image = /needs: \[(.+)\]/.exec(all.get("image")!.join("\n"))![1].split(", ")
    assert.ok(image.includes("e2e"), `${file}: a failed e2e would still publish an image`)
  }
})

// The suite pulls images; it pushes nothing and reaches no server. A credential here would be
// one more job holding a token for no reason — the private-service case is commented out on the
// job, permission and variable together, so uncommenting one without the other is not a thing
// that can happen silently.
test("the e2e job holds no credential and no extra permission", () => {
  for (const file of WORKFLOWS) {
    const text = jobs(file).get("e2e")!.join("\n")
    for (const right of ["permissions:", "packages: read", "packages: write", "SHIPKIT_"]) {
      assert.ok(!text.includes(right), `${file}: the e2e job asks for ${right}`)
    }
  }
})

// Split across runners, `push` finds no image in the engine's cache and skips itself: a green
// run that published nothing. This is why `--stage` takes a list (ADR 0001, amendment).
test("build and push are selected together, in one job", () => {
  for (const file of WORKFLOWS) {
    const withStage = [...jobs(file)].filter(([, block]) => block.some((l) => l.includes("--stage=")))
    const publishing = withStage.filter(([, block]) => block.some((l) => l.includes("build,push")))
    assert.equal(publishing.length, 1, file)
    for (const [name, block] of withStage) {
      for (const stage of ["--stage=build\n", "--stage=push "]) {
        assert.ok(!block.some((l) => l.includes(stage)), `${file}: ${name} runs half of build,push`)
      }
    }
  }
})

// A stage that failed is the one whose report the summary most needs; `if: always()` on the
// upload is what puts it there. True of the deploy's report above all: it is what says whether
// a rollback fired and where the pre-deploy dump is.
test("every job that writes a report uploads it even when the job failed", () => {
  for (const file of WORKFLOWS) {
    for (const [name, block] of jobs(file)) {
      if (!block.some((l) => l.includes("--report="))) continue
      const upload = block.findIndex((l) => l.includes("actions/upload-artifact@"))
      assert.ok(upload >= 0, `${file}: ${name} produces a report nothing collects`)
      assert.equal(block[upload + 1].trim(), "if: always()", `${file}: ${name}`)
      const report = /--report=(\S+)/.exec(block.join("\n"))![1]
      assert.ok(block.some((l) => l.trim() === `path: ${report}`), `${file}: ${name} uploads a different path`)
    }
  }
})

// The summary is for the runs that went wrong. A `needs` that missed a job, or a missing
// `if: always()`, would take it away from exactly those runs.
test("the summary needs every check job and runs anyway", () => {
  for (const file of WORKFLOWS) {
    const all = jobs(file)
    const summary = all.get("summary")!
    const needs = /needs: \[(.+)\]/.exec(summary.join("\n"))![1].split(", ")
    // Every job but the deploy, which renders its own summary from its own report in its own
    // job: holding the CI summary behind a deploy would take it away from the reader who wants
    // to know whether the commit was fit to release in the first place.
    assert.deepEqual(needs.sort(), [...all.keys()].filter((n) => n !== "summary" && n !== "deploy").sort(), file)
    assert.ok(summary.some((l) => l.trim() === "if: always()"), file)
    assert.ok(summary.some((l) => l.includes("GITHUB_STEP_SUMMARY")), file)
    // Without the jobs' own results a job that failed before writing a report is invisible,
    // and the summary says "ok" on a red run.
    assert.ok(summary.some((l) => l.includes("--jobs")), file)
  }
})

// The blast radius of a compromised action is the token in the job that runs it.
test("only the job that may publish is given a write token", () => {
  for (const file of WORKFLOWS) {
    assert.match(readFileSync(file, "utf8"), /^permissions:\n  contents: read$/m, file)
    for (const [name, block] of jobs(file)) {
      const text = block.join("\n")
      const publishes = text.includes("--stage=build,push")
      assert.equal(text.includes("packages: write"), publishes, `${file}: ${name}`)
      // The deploy pulls what that job published, so it carries the same variable with a
      // read-only right. Nobody else has any business holding a registry credential.
      const deploys = name === "deploy"
      assert.equal(text.includes("SHIPKIT_REGISTRY_TOKEN"), publishes || deploys, `${file}: ${name}`)
      assert.equal(text.includes("packages: read"), deploys, `${file}: ${name}`)
      assert.equal(text.includes("deployments: write"), deploys, `${file}: ${name}`)
      // An unused OIDC token that can assume a cloud role is a credential lying around.
      assert.ok(!text.includes("id-token: write"), `${file}: ${name} asks for an OIDC token`)
    }
  }
})

/**
 * The deploy job. Everything asserted here is a property that is silent when it is wrong: a
 * deploy that runs on a pull request, two deploys migrating one database at once, a deploy
 * cancelled halfway through a migration, or an SSH key handed to a job that has no use for it.
 * None of them shows up as a red run; each of them shows up in production.
 */
test("the deploy job runs only on a push to the branch that publishes", () => {
  for (const file of WORKFLOWS) {
    const deploy = jobs(file).get("deploy")!
    const text = deploy.join("\n")
    assert.match(text, /if: github\.event_name == 'push'/, file)
    // Named, not read from GitHub's default branch: those are different things, and the first
    // project to use this released from `main` while its GitHub default was `dev` — the deploy
    // skipped on the merge it exists for. The comment beside it says to keep the two in step.
    assert.match(text, /github\.ref_name == '[^']+'/, file)
    assert.doesNotMatch(text, /ref_name == github\.event\.repository\.default_branch/, file)
    // The image it releases must be the one this run published, from this commit, and the
    // browser suite must have passed against it first.
    assert.match(text, /needs: \[image, e2e\]/, file)
  }
})

test("one deploy at a time, and never a cancelled one", () => {
  for (const file of WORKFLOWS) {
    const text = jobs(file).get("deploy")!.join("\n")
    assert.match(text, /concurrency:/, file)
    assert.match(text, /group: shipkit-deploy-/, file)
    // A deploy cancelled between `migrate` and `verify` leaves production on a schema nothing
    // has verified. This line is the only thing preventing it.
    assert.match(text, /cancel-in-progress: false/, file)
  }
})

test("the deploy job is the only one that sees the deploy key", () => {
  for (const file of WORKFLOWS) {
    for (const [name, block] of jobs(file)) {
      const uses = block.join("\n").includes("SHIPKIT_SSH_KEY")
      assert.equal(uses, name === "deploy", `${file}: ${name}`)
    }
    const deploy = jobs(file).get("deploy")!.join("\n")
    // An empty secret is a deploy that fails somewhere further in, against a server it never
    // reached. It is refused here, by name.
    assert.match(deploy, /test -n "\$SHIPKIT_SSH_KEY"/, file)
    // Created empty with mode 600 and only then written: never world-readable, not for an instant.
    assert.match(deploy, /install -m 600 \/dev\/null/, file)
  }
})

// `--auto` is the only form that may run here: `--yes` would need a token nobody in a workflow
// has read a plan for, and `--plan` deploys nothing. The report is what every step after it
// reads, so it is not optional either.
test("the deploy job calls --auto with a report", () => {
  for (const file of WORKFLOWS) {
    const deploy = jobs(file).get("deploy")!
    const calls = runLines(deploy).filter((l) => l.includes('"$SHIPKIT" deploy'))
    assert.equal(calls.length, 1, file)
    assert.match(calls[0], /^node "\$SHIPKIT" deploy --auto --report=reports\/deploy\.json$/, file)
    assert.ok(!calls[0].includes("--yes"), file)
  }
})

// The plan and the command that executes it have to be somewhere a person looks, and that is
// not the log of a job that failed twenty steps ago.
test("the deploy job writes its summary and its deployment record even when it failed", () => {
  for (const file of WORKFLOWS) {
    const deploy = jobs(file).get("deploy")!
    const text = deploy.join("\n")
    assert.match(text, /node "\$SHIPKIT" summary reports --title Deploy >> "\$GITHUB_STEP_SUMMARY"/, file)
    assert.match(text, /node "\$SHIPKIT" summary reports --deployment-status /, file)
    // Both guarded the same way: run always, unless the kit itself was never fetched.
    const always = deploy.filter((l) => l.trim() === "if: always() && env.SHIPKIT != ''")
    assert.equal(always.length, 2, `${file}: the summary and the record must both run on a failed deploy`)
  }
})

// The state must come from the report, not from the job. Using Actions' own `environment:` key
// would create a second deployment whose status follows the job's outcome — which is exactly
// the thing that must not decide it.
test("the deployment status is posted from the wrapper's own mapping", () => {
  for (const file of WORKFLOWS) {
    const deploy = jobs(file).get("deploy")!
    const text = deploy.join("\n")
    assert.ok(!deploy.some((l) => /^ {4}environment:/.test(l)), `${file}: the job uses Actions' environment key`)
    assert.match(text, /gh api "repos\/\$GITHUB_REPOSITORY\/deployments" --input/, file)
    assert.match(text, /deployments\/\$id\/statuses" --input/, file)
  }
})

// The variable exists for one stage of one kind of project. A `db: none` project has no schema,
// so it has no connection string to hold, and a template that asks for one anyway teaches its
// reader that the kit needs a secret it does not.
test("only the database variant asks for a production connection string", () => {
  assert.ok(code(WITH_DB).some((l) => l.includes("SHIPKIT_DATABASE_URL")), WITH_DB)
  assert.ok(!code(NO_DB).some((l) => l.includes("SHIPKIT_DATABASE_URL")), NO_DB)
})

/**
 * The first major of each action whose `action.yml` declares `using: node24`. Verified on
 * 2026-09-21 by reading `runs.using` at the tag's own commit:
 *
 *   git ls-remote --tags https://github.com/<owner>/<action>
 *   curl -fsSL https://raw.githubusercontent.com/<owner>/<action>/<commit>/action.yml
 *
 * Not guessed from release notes: the runtime an action declares is in that file and nowhere
 * else. A node20 action warns today and stops running when the runner drops it.
 */
const NODE24_FROM: Record<string, number> = {
  "actions/checkout": 5,
  "actions/setup-node": 5,
  "actions/upload-artifact": 6,
  "actions/download-artifact": 7,
  "docker/setup-qemu-action": 4,
}

test("every pinned action is at a version that declares node24", () => {
  for (const file of [...WORKFLOWS, SETUP]) {
    const uses = code(file)
      .map((l) => /uses: (\S+@[0-9a-f]{40}) # v(\d+)\.\d+\.\d+$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
    assert.ok(uses.length > 0, file)
    for (const [, pin, major] of uses) {
      const action = pin.split("@")[0]
      const min = NODE24_FROM[action]
      assert.ok(min !== undefined, `${file}: ${action} has no verified node24 version in this table`)
      assert.ok(Number(major) >= min, `${file}: ${pin} is below v${min}, the first node24 major`)
    }
  }
})

// The client repository has no copy of the kit: what runs its pipeline is whatever this step
// downloads. A tag or a branch there would be a line someone else can point at other code.
test("the setup action fetches the kit by commit and checks what it installs", () => {
  const text = code(SETUP).join("\n")
  assert.match(text, /\[0-9a-f\]\\\{40\\\}/, "the kit pin is not required to be a 40-character commit")
  assert.match(text, /sha256sum -c -/, "Dagger is installed without checking the archive")
  assert.match(text, /[0-9a-f]{64}/, "no pinned sha256 for the Dagger archive")
  assert.ok(!text.includes("install.sh"), "an installer is piped into a shell")
  // Every job, one place. A job that installed its own Dagger could run the same commit on a
  // different engine from the job beside it — including the job that deploys it.
  for (const file of WORKFLOWS) {
    const setupUses = code(file).filter((l) => l.trim() === "- uses: ./.github/actions/setup")
    assert.equal(setupUses.length, jobs(file).size, `${file}: a job does not use the setup action`)
    assert.ok(!code(file).some((l) => l.includes("dagger.io")), `${file}: installs Dagger of its own`)
  }
})

/**
 * The two variants are one workflow. Keeping them in step by hand is exactly the drift ADR 0001
 * warns about, so the differences are stated here instead, and there are three: the Migrations
 * job, its name in the two `needs:` lists, and the one environment variable that exists only
 * because a project has a database. Anything else diverging is a mistake in one of the files.
 */
const DB_ONLY = ["SHIPKIT_DATABASE_URL: ${{ secrets.SHIPKIT_DATABASE_URL }}"]

test("the no-database variant is the workflow without the Migrations job", () => {
  const derived: string[] = []
  let skipping = false
  for (const line of code(WITH_DB)) {
    const header = /^ {2}([a-z][\w-]*):$/.exec(line)
    if (header) skipping = header[1] === "migrations"
    if (skipping || DB_ONLY.includes(line.trim())) continue
    derived.push(line.replace(/needs: \[(.+)\]/, (_, list: string) => `needs: [${list.split(", ").filter((n) => n !== "migrations").join(", ")}]`))
  }
  assert.deepEqual(code(NO_DB), derived)
})
