import { test } from "node:test"
import assert from "node:assert/strict"
import {
  parseDotnetTestSummary,
  parseMigrationList,
  migrationsAfter,
  parseTargetFramework,
} from "../.dagger/src/adapters/dotnet-parse.ts"

// Captured from `dotnet test` on fixtures/dotnet-api, 2026-09-12.
const REAL_PASS = `Test run for /src/tests/Api.IntegrationTests/bin/Debug/net10.0/Api.IntegrationTests.dll (.NETCoreApp,Version=v10.0)
A total of 1 test files matched the specified pattern.

Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 3 s - Api.IntegrationTests.dll (net10.0)`

test("parses a real passing run", () => {
  assert.deepEqual(parseDotnetTestSummary(REAL_PASS), {
    passed: 3, failed: 0, skipped: 0, total: 3,
  })
})

test("parses a failing run", () => {
  const raw = `Failed!  - Failed:     2, Passed:     1, Skipped:     0, Total:     3, Duration: 4 s`
  assert.deepEqual(parseDotnetTestSummary(raw), {
    passed: 1, failed: 2, skipped: 0, total: 3,
  })
})

test("sums multiple test projects", () => {
  const raw = `Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 3 s
Passed!  - Failed:     0, Passed:     7, Skipped:     1, Total:     8, Duration: 2 s`
  assert.deepEqual(parseDotnetTestSummary(raw), {
    passed: 10, failed: 0, skipped: 1, total: 11,
  })
})

test("a run that discovered nothing is distinguishable from a pass", () => {
  // The gate depends on telling "no summary" apart from "all passed".
  assert.equal(parseDotnetTestSummary("No test is available in the specified files."), null)
})

test("zero totals are reported as zero, not as null", () => {
  const raw = `Passed!  - Failed:     0, Passed:     0, Skipped:     0, Total:     0, Duration: 1 s`
  assert.deepEqual(parseDotnetTestSummary(raw), { passed: 0, failed: 0, skipped: 0, total: 0 })
})

// --- migration list parsing ---------------------------------------------------------------

/** Real `dotnet ef migrations list` output from the fixture, database unreachable (the CI case). */
const REAL_LIST = `An error occurred using the connection to database 'app' on server 'tcp://design-time-placeholder:5432'.
An error occurred while accessing the database. Continuing without the information provided by the database. Error: nodename nor servname provided, or not known
20260912083112_InitialCreate
Pending status not shown. Unable to determine which migrations have been applied. This can happen when your project uses a version of Entity Framework Core lower than 5.0.0 or when an error occurs while accessing the database.`

test("extracts ids from real output surrounded by connection warnings", () => {
  assert.deepEqual(parseMigrationList(REAL_LIST), ["20260912083112_InitialCreate"])
})

test("the trailing note is not mistaken for a migration", () => {
  assert.equal(parseMigrationList(REAL_LIST).length, 1)
})

test("migrationsAfter returns everything when nothing is deployed", () => {
  const ids = ["20260101000000_A", "20260202000000_B"]
  assert.deepEqual(migrationsAfter(ids, null), ids)
})

test("migrationsAfter returns only what follows the deployed one", () => {
  const ids = ["20260101000000_A", "20260202000000_B", "20260303000000_C"]
  assert.deepEqual(migrationsAfter(ids, "20260101000000_A"), [
    "20260202000000_B",
    "20260303000000_C",
  ])
})

test("nothing is pending when the deployed migration is the last one", () => {
  const ids = ["20260101000000_A"]
  assert.deepEqual(migrationsAfter(ids, "20260101000000_A"), [])
})

test("an unknown deployed id is treated as everything pending, not nothing", () => {
  // Failing towards "more to inspect" is the safe direction: treating an unrecognised
  // marker as "nothing pending" would skip the gate entirely.
  const ids = ["20260101000000_A", "20260202000000_B"]
  assert.deepEqual(migrationsAfter(ids, "20259999999999_Unknown"), ids)
})

// --- target framework -----------------------------------------------------------------

test("reads the version a project targets", () => {
  // Real Api.csproj shape, from Roadly.
  const csproj = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`
  assert.equal(parseTargetFramework(csproj), "9.0")
})

test("reads a two-digit major version", () => {
  assert.equal(parseTargetFramework(`<TargetFramework>net10.0</TargetFramework>`), "10.0")
})

test("a multi-targeting project has no single answer and says so", () => {
  // Guessing one of them would pick an SDK image the project only half-supports.
  const csproj = `<TargetFrameworks>net8.0;net9.0</TargetFrameworks>`
  assert.equal(parseTargetFramework(csproj), null)
})

test("a non-net target framework is not read as a version", () => {
  assert.equal(parseTargetFramework(`<TargetFramework>netstandard2.0</TargetFramework>`), null)
})

test("a project file without a target framework yields null", () => {
  assert.equal(parseTargetFramework(`<Project Sdk="Microsoft.NET.Sdk" />`), null)
})
