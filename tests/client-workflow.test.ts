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

// ADR 0001, as amended: the rule is per job now, and it is still "a checkout and one call".
// Anything else in a `run:` is pipeline logic that moved into YAML, which is the leak this
// whole layering exists to prevent.
test("every job runs the wrapper and nothing else", () => {
  for (const file of WORKFLOWS) {
    for (const [name, block] of jobs(file)) {
      for (const line of runLines(block)) {
        assert.match(
          line,
          /^(node "\$SHIPKIT" (ci --stage=|summary reports )|printf '%s' "\$NEEDS" > )/,
          `${file}: job ${name} runs something that is not the wrapper: ${line}`,
        )
      }
    }
  }
})

test("one job per stage, and the summary knows about all of them", () => {
  const stages = (file: string) =>
    code(file)
      .map((l) => /--stage=(\S+)/.exec(l)?.[1])
      .filter((s): s is string => s !== undefined)

  assert.deepEqual(stages(WITH_DB), ["pre", "test", "db", "build,push"])
  assert.deepEqual(stages(NO_DB), ["pre", "test", "build,push"])
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
// upload is what puts it there.
test("every stage job uploads its report even when the stage failed", () => {
  for (const file of WORKFLOWS) {
    for (const [name, block] of jobs(file)) {
      if (!block.some((l) => l.includes("--stage="))) continue
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
test("the summary needs every other job and runs anyway", () => {
  for (const file of WORKFLOWS) {
    const all = jobs(file)
    const summary = all.get("summary")!
    const needs = /needs: \[(.+)\]/.exec(summary.join("\n"))![1].split(", ")
    assert.deepEqual(needs.sort(), [...all.keys()].filter((n) => n !== "summary").sort(), file)
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
      assert.equal(text.includes("SHIPKIT_REGISTRY_TOKEN"), publishes, `${file}: ${name}`)
    }
  }
})

// Automatic deploys are out of this wave. A workflow that still carried the job would deploy
// on merge from a template nobody meant to hand out.
test("the client templates deploy nothing", () => {
  for (const file of WORKFLOWS) {
    assert.ok(!jobs(file).has("deploy"), file)
    assert.ok(!code(file).some((l) => l.includes("shipkit\" deploy") || l.includes("SHIPKIT_SSH_KEY")), file)
  }
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
  // Five jobs, one place. A job that installed its own Dagger could run the same commit on a
  // different engine from the job beside it.
  for (const file of WORKFLOWS) {
    const setupUses = code(file).filter((l) => l.trim() === "- uses: ./.github/actions/setup")
    assert.equal(setupUses.length, jobs(file).size, `${file}: a job does not use the setup action`)
    assert.ok(!code(file).some((l) => l.includes("dagger.io")), `${file}: installs Dagger of its own`)
  }
})

/**
 * The two variants are one workflow. Keeping them in step by hand is exactly the drift ADR 0001
 * warns about, so the difference is stated here instead: the Migrations job, and its name in the
 * two `needs:` lists. Anything else diverging is a mistake in one of the two files.
 */
test("the no-database variant is the workflow without the Migrations job", () => {
  const derived: string[] = []
  let skipping = false
  for (const line of code(WITH_DB)) {
    const header = /^ {2}([a-z][\w-]*):$/.exec(line)
    if (header) skipping = header[1] === "migrations"
    if (skipping) continue
    derived.push(line.replace(/needs: \[(.+)\]/, (_, list: string) => `needs: [${list.split(", ").filter((n) => n !== "migrations").join(", ")}]`))
  }
  assert.deepEqual(code(NO_DB), derived)
})
