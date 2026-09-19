import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  DEFAULT_MIGRATION_TIMEOUTS,
  bundleRunScript,
  pgDuration,
  pgOptions,
} from "../.dagger/src/core/migrate-options.ts"

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
 * Runs the local half of the bundle command with `ssh` replaced by a decoder, so the result is
 * the script the server would run.
 */
function remoteScriptFor(dbUrl: string) {
  const cmd = bundleRunScript({
    remotePath: "/tmp/shipkit-efbundle-1",
    network: "kamal",
    image: "mcr.microsoft.com/dotnet/runtime-deps:10.0",
    timeouts: { lockTimeout: "5s", statementTimeout: "15min" },
    ssh: "sh -c 'base64 -d' _",
  })
  return spawnSync("sh", ["-c", cmd], { encoding: "utf8", env: { PATH: process.env.PATH, SHIPKIT_DB_URL: dbUrl } })
}

test("the bundle runs with PGOPTIONS carrying both timeouts", () => {
  const r = remoteScriptFor("Host=db;Database=app;Username=u;Password=p")
  assert.equal(r.status, 0, r.stderr)
  assert.match(
    r.stdout,
    /docker run --rm --network kamal -e "PGOPTIONS=-c lock_timeout=5s -c statement_timeout=15min" -v \/tmp\/shipkit-efbundle-1:\/efbundle:ro \S+ \/efbundle --connection "Host=db;Database=app;Username=u;Password=p"/,
  )
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
    assert.doesNotMatch(r.stdout, /docker run/)
  }
})

test("a password merely containing the word options is not refused", () => {
  const r = remoteScriptFor("Host=db;Password=myoptions=1")
  assert.equal(r.status, 0, r.stderr)
})
