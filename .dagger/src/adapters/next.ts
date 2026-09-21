import { dag, CacheSharingMode, Container, Directory, Service } from "@dagger.io/dagger"
import { Config } from "../config.js"
import { configError, infraError } from "../errors.js"
import { StackAdapter, TestSummary } from "./types.js"
import { parseVitestSummary } from "./next-parse.js"

const nodeImage = (version: string) => `node:${version}-alpine`
const SRC = "/src"

/**
 * The lint step, per tool the project may have chosen (docs/multi-stack-plan.md §6 — the
 * adapter does not guess which one a project uses; shipkit.yaml says).
 *
 * `npx --no-install` is what keeps this a gate. Plain `npx eslint` downloads whatever the
 * registry currently publishes under that name when the project does not depend on it, so a
 * repository that lost its linter would still go green, linted by a tool nobody pinned.
 */
const LINTERS: Record<string, string[]> = {
  eslint: ["npx", "--no-install", "eslint", "--max-warnings", "0"],
  biome: ["npx", "--no-install", "biome", "ci", "."],
}

/**
 * Next.js on Node — the second adapter, and the one with no database (§6).
 *
 * There is no `db` member: a Next site has no migrations, and config.ts refuses
 * `db: postgres` for this stack rather than letting the core skip the db, backup and migrate
 * stages for want of an adapter to run them (adapters/requirements.ts).
 *
 * Same constraint as dotnet.ts: no `npm`, `npx` or `next` command may appear outside this
 * file. If one shows up in core/, the seam has leaked.
 */
export class NextAdapter implements StackAdapter {
  readonly name = "next"

  restore(src: Directory, cfg: Config): Container {
    return dag
      .container()
      .from(nodeImage(cfg.stackVersion))
      // `.next` is a build directory the size of the dependency tree. It is not on the core's
      // ignore list, which is the .NET-shaped one (bin/obj), so a developer who has ever run
      // `next dev` would otherwise upload it and bust the cache on every run.
      .withDirectory(SRC, src.withoutDirectory(".next"))
      .withWorkdir(SRC)
      .withEnvVariable("NEXT_TELEMETRY_DISABLED", "1")
      // Non-interactive, and it is what makes the runners' output deterministic enough to parse.
      .withEnvVariable("CI", "true")
      .withMountedCache("/root/.npm", dag.cacheVolume("npm"), { sharing: CacheSharingMode.Shared })
      // `npm ci`, never `install`: it installs exactly what package-lock.json pins and refuses
      // when the lock and package.json disagree. `install` would resolve something newer and
      // quietly rewrite the lock, so the pipeline would be testing a tree the repository does
      // not describe. A project with no lock file is refused here, by npm, with that message.
      .withExec(["npm", "ci"])
  }

  lint(c: Container, cfg: Config): Container {
    const linter = LINTERS[cfg.lint]
    if (!linter) {
      // Unreachable through loadConfig, which checks the value against the same list. Kept so
      // the adapter is not the thing that decides silently when it is called from elsewhere.
      throw configError(
        `lint "${cfg.lint}" is not a tool the next adapter can run`,
        `Set lint in shipkit.yaml to one of: ${Object.keys(LINTERS).join(", ")}.`,
      )
    }
    return (
      c
        .withExec(linter)
        // A type error is a build failure. Without this it is found by `next build` in the
        // image stage, minutes later and after the gates that were supposed to catch it —
        // `tsc --noEmit` is the same finding in `pre`, in seconds.
        .withExec(["npx", "--no-install", "tsc", "--noEmit"])
    )
  }

  test(c: Container, cfg: Config, services: { postgres?: Service }): Container {
    let t = c
    if (services.postgres) {
      // Not reached while this stack is `db: none` — the core starts no database for it. The
      // binding is still honoured rather than ignored: it is the core's to hand over, and a
      // full-stack Next project reads DATABASE_URL like any other Node one.
      t = t
        .withServiceBinding("postgres", services.postgres)
        .withEnvVariable("DATABASE_URL", "postgres://postgres:postgres@postgres:5432/app_test")
    } else if (cfg.db !== "none") {
      throw infraError("no postgres service was bound for the test stage")
    }
    // --passWithNoTests turns "found nothing" into a summary the core can read instead of a
    // bare exit code: whether zero tests is a failure is the core's call (gates.ts), and it
    // can only make it if the run reports counts. Vitest exits 0 for a file that contains no
    // test at all, so that decision is not academic.
    //
    // `sh -c` with 2>&1 because the core reads stdout, and which stream a runner prints its
    // summary on is not a thing to depend on.
    return t.withExec(["sh", "-c", "npx --no-install vitest run --passWithNoTests 2>&1"])
  }

  parseTestSummary(raw: string): TestSummary | null {
    return parseVitestSummary(raw)
  }
}
