import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_MIGRATION_TIMEOUTS,
  refuseOwnOptions,
  pgDuration,
  pgOptions,
} from "../.dagger/src/core/migrate-options.ts"
import { runBundleCommand } from "../.dagger/src/core/ssh-command.ts"

// B5: squawk.default.toml excludes require-lock-timeout / require-statement-timeout because
// the migrate stage sets both on the bundle's connection. These tests are that promise.

test("durations need a unit and may not be zero", () => {
  assert.equal(pgDuration("5s"), "5s")
  assert.equal(pgDuration("15min"), "15min")
  assert.equal(pgDuration("250ms"), "250ms")
  // A bare number is milliseconds to PostgreSQL; 0 switches the timeout off.
  for (const bad of ["5", "0", "0s", "", "5 s", "-1s", "5s; rm -rf /", "5s -c search_path=x", 5]) {
    assert.equal(pgDuration(bad), null, `accepted ${JSON.stringify(bad)}`)
  }
})

test("the defaults are valid durations", () => {
  assert.equal(pgDuration(DEFAULT_MIGRATION_TIMEOUTS.lockTimeout), DEFAULT_MIGRATION_TIMEOUTS.lockTimeout)
  assert.equal(pgDuration(DEFAULT_MIGRATION_TIMEOUTS.statementTimeout), DEFAULT_MIGRATION_TIMEOUTS.statementTimeout)
})

test("both timeouts are set as server options", () => {
  assert.equal(
    pgOptions({ lockTimeout: "5s", statementTimeout: "15min" }),
    "-c lock_timeout=5s -c statement_timeout=15min",
  )
})

/**
 * Runs the real migrate command with `ssh` replaced by a local sh and `docker` recording the
 * argv it received, so the test sees what the server would actually run.
 */
function remoteScriptFor(dbUrl: string) {
  const work = mkdtempSync(join(tmpdir(), "shipkit-migrate-options-"))
  const bin = join(work, "bin")
  const dir = join(work, "stage")
  spawnSync("mkdir", ["-p", bin, dir])
  writeFileSync(join(dir, "efbundle"), "")
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexec sh\n")
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${work}/docker-argv"\n`)
  chmodSync(join(bin, "ssh"), 0o755)
  chmodSync(join(bin, "docker"), 0o755)
  const env = { url: "http://x", host: "h", sshPort: 22, sshUser: "deploy", network: "kamal", database: "app", dbUser: "u" }
  const cmd =
    `${refuseOwnOptions("SHIPKIT_DB_URL")}; ` +
    runBundleCommand(env, dir, "mcr.microsoft.com/dotnet/runtime-deps:10.0", {
      pgOptions: pgOptions({ lockTimeout: "5s", statementTimeout: "15min" }),
    })
  const r = spawnSync("sh", ["-c", cmd], {
    cwd: work,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, SHIPKIT_DB_URL: dbUrl },
  })
  const argvFile = join(work, "docker-argv")
  const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\0").slice(0, -1) : null
  rmSync(work, { recursive: true, force: true })
  return { ...r, argv }
}

test("the bundle runs with PGOPTIONS carrying both timeouts", () => {
  const r = remoteScriptFor("Host=db;Database=app;Username=u;Password=p")
  assert.equal(r.status, 0, r.stderr)
  const i = r.argv!.indexOf("-e")
  assert.equal(r.argv![i + 1], "PGOPTIONS=-c lock_timeout=5s -c statement_timeout=15min")
  assert.equal(r.argv!.at(-1), "Host=db;Database=app;Username=u;Password=p")
})

test("a connection string with its own Options is refused before anything runs", () => {
  // Npgsql ignores PGOPTIONS when the connection string has Options, so the timeouts would be
  // dropped silently.
  for (const url of [
    "Host=db;Options=-c search_path=app;Password=p",
    "Host=db; options = -c x=1",
    "options=-c x=1;Host=db",
  ]) {
    const r = remoteScriptFor(url)
    assert.notEqual(r.status, 0, `accepted ${url}`)
    assert.match(r.stderr, /sets Options=/)
    assert.equal(r.argv, null)
  }
})

test("a password merely containing the word options is not refused", () => {
  const r = remoteScriptFor("Host=db;Password=myoptions=1")
  assert.equal(r.status, 0, r.stderr)
})
