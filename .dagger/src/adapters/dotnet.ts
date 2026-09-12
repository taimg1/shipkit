import { dag, CacheSharingMode, Container, Directory, File, Service } from "@dagger.io/dagger"
import { Config } from "../config.js"
import { infraError } from "../errors.js"
import { DbAdapter, StackAdapter } from "./types.js"

const SDK_IMAGE = "mcr.microsoft.com/dotnet/sdk:10.0"
const SRC = "/src"

/**
 * .NET + EF Core. The only adapter in v1.
 *
 * Constraint from docs/multi-stack-plan.md §8: no `dotnet` command may appear outside this
 * file. If one shows up in core/, the seam has leaked and step 3 becomes a rewrite.
 */
export class DotnetAdapter implements StackAdapter {
  readonly name = "dotnet"
  readonly db: DbAdapter = new EfCoreDb()

  restore(src: Directory, _cfg: Config): Container {
    return dag
      .container()
      .from(SDK_IMAGE)
      // Cache busting is the main cost here: bin/ and obj/ are excluded at the --source
      // boundary in index.ts, so they never reach this directory.
      .withDirectory(SRC, src)
      .withWorkdir(SRC)
      .withEnvVariable("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
      .withEnvVariable("DOTNET_NOLOGO", "1")
      .withMountedCache(
        "/root/.nuget/packages",
        dag.cacheVolume("nuget"),
        { sharing: CacheSharingMode.Shared },
      )
      .withExec(["dotnet", "restore"])
  }

  lint(c: Container, _cfg: Config): Container {
    return c
      .withExec(["dotnet", "format", "--verify-no-changes", "--no-restore"])
      // -warnaserror is what makes analyzer findings a gate rather than a suggestion.
      .withExec(["dotnet", "build", "--no-restore", "-warnaserror"])
  }

  test(c: Container, cfg: Config, services: { postgres?: Service }): Container {
    let t = c
    if (services.postgres) {
      // D2: inside Dagger the database arrives as a service binding. The project's test
      // fixture uses ConnectionStrings__Test when present and falls back to Testcontainers
      // on a developer laptop, so there is one fixture with two transports.
      t = t
        .withServiceBinding("postgres", services.postgres)
        .withEnvVariable(
          "ConnectionStrings__Test",
          "Host=postgres;Port=5432;Database=app_test;Username=postgres;Password=postgres",
        )
    } else if (cfg.db !== "none") {
      throw infraError("no postgres service was bound for the test stage")
    }
    return t.withExec(["dotnet", "test", "--no-restore", "--logger", "trx;LogFileName=test.trx"])
  }
}

class EfCoreDb implements DbAdapter {
  readonly historyTable = "__EFMigrationsHistory"

  /**
   * SDK container with dotnet-ef available AND a completed build.
   *
   * The build is not an optimisation. `dotnet ef migrations add` does not rebuild, so an
   * assembly can easily lack the migration that was just written; `--no-build` then emits
   * an empty script and the whole `db` gate inspects nothing. Building here makes
   * `--no-build` below an honest claim rather than a silent failure mode.
   */
  private tooling(src: Directory, cfg: Config): Container {
    return new DotnetAdapter()
      .restore(src, cfg)
      .withExec(["dotnet", "tool", "install", "--global", "dotnet-ef", "--version", "10.*"])
      .withEnvVariable("PATH", "/root/.dotnet/tools:$PATH", { expand: true })
      .withExec(["dotnet", "build", "--no-restore"])
  }

  private projectArgs(cfg: Config): string[] {
    // Both projects come from shipkit.yaml — in a multi-project solution the startup and
    // migrations projects differ, and guessing produces a confusing failure deep in EF.
    //
    // The STARTUP project must reference Microsoft.EntityFrameworkCore.Design or the tools
    // refuse to run. This is a requirement on the client project, not something the kit can
    // supply — see fixtures/dotnet-api for the working arrangement.
    return ["--project", cfg.migrationsProject ?? cfg.project, "--startup-project", cfg.project]
  }

  pendingSql(src: Directory, cfg: Config, from: string | null): File {
    // NON-idempotent on purpose: --idempotent wraps statements in DO $$ blocks that Squawk
    // may not analyse (ci-cd-plan.md §7.2). Lint this; apply the bundle.
    //
    // Verified argument form: `script <from>` with no second argument runs from <from> to
    // HEAD. "0" is EF's name for "from the beginning". A file of only a UTF-8 BOM means
    // nothing is pending — which is why dbStage cross-checks against the migration list.
    return this.tooling(src, cfg)
      .withExec([
        "dotnet", "ef", "migrations", "script",
        from ?? "0",
        "--output", "/out/migration.sql",
        "--no-build",
        ...this.projectArgs(cfg),
      ])
      .file("/out/migration.sql")
  }

  applyArtifact(src: Directory, cfg: Config): Container {
    // A bundle needs no SDK and no source on the target machine. It must be self-contained
    // or it will not run on a bare server.
    return this.tooling(src, cfg).withExec([
      "dotnet", "ef", "migrations", "bundle",
      "--self-contained", "-r", "linux-x64",
      "--output", "/out/efbundle",
      "--force",
      ...this.projectArgs(cfg),
    ])
  }

  async lastApplied(dsn: string, _cfg: Config, _src: Directory): Promise<string | null> {
    // D5: read the marker back from production rather than keeping a separate store.
    const out = await dag
      .container()
      .from("postgres:17-alpine")
      .withEnvVariable("CACHEBUST", Date.now().toString())
      .withExec([
        "psql", dsn, "-tAc",
        `select "MigrationId" from "${this.historyTable}" order by "MigrationId" desc limit 1`,
      ])
      .stdout()
    const id = out.trim()
    return id.length > 0 ? id : null
  }

  async pendingList(src: Directory, cfg: Config, from: string | null): Promise<string[]> {
    const out = await this.tooling(src, cfg)
      .withExec(["dotnet", "ef", "migrations", "list", "--no-build", ...this.projectArgs(cfg)])
      .stdout()

    // `migrations list` also prints connection warnings and a trailing note about pending
    // status when it cannot reach the database, which is the normal case in CI. Matching the
    // id format is what separates migrations from that noise.
    const ids = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\d{14}_/.test(l))
    if (!from) return ids
    const idx = ids.indexOf(from)
    return idx < 0 ? ids : ids.slice(idx + 1)
  }
}
