import { test } from "node:test"
import assert from "node:assert/strict"
import { summarizeOutput } from "../.dagger/src/core/output.ts"

// Real `dotnet format --verify-no-changes` lines from a client project (#9).
const formatLine = (file: string, row: number) =>
  `/src/${file}(${row},5): error WHITESPACE: Fix whitespace formatting. Insert '\\s\\s\\s\\s'. [/src/Tests/Tests.csproj]`

const FORMAT = [
  ...Array.from({ length: 40 }, (_, i) => formatLine("Domain/BlogPosts/Slugs.cs", 28 + i)),
  ...Array.from({ length: 4 }, (_, i) => formatLine("Tests/Application/Users/BootstrapAdminTests.cs", 118 + i)),
  ...Array.from({ length: 4 }, (_, i) => formatLine("Tests/Application/Users/ManageUserCommandHandlerTests.cs", 123 + i)),
  ...Array.from({ length: 4 }, (_, i) => formatLine("Tests/Application/Users/UpsertCurrentUserCommandHandlerTests.cs", 58 + i)),
  ...Array.from({ length: 4 }, (_, i) => formatLine("Tests/Application/Bookings/CreateBookingCommandHandlerTests.cs", 838 + i)),
].join("\n")

test("a cut output says how much was cut", () => {
  const s = summarizeOutput(FORMAT, "")
  assert.equal(s.output.length, 20)
  assert.equal(s.omitted, 36)
  assert.equal(s.fullOutput?.length, 56)
})

test("compiler-style errors are counted and grouped by file", () => {
  const d = summarizeOutput(FORMAT, "").diagnostics!
  assert.equal(d.errors, 56)
  assert.equal(d.warnings, 0)
  assert.equal(d.files.length, 5)
  assert.deepEqual(d.files[0], { path: "Domain/BlogPosts/Slugs.cs", count: 40 })
  assert.deepEqual(d.codes, { WHITESPACE: 56 })
})

test("dotnet build's repeated summary is not counted twice", () => {
  // Real shape: each error inline, then all of them again after "Build FAILED."
  const errs = [
    "/src/Infrastructure/Notifications/EmailNotificationSender.cs(24,47): error CS8604: Possible null reference argument for parameter 'text'. [/src/Infrastructure/Infrastructure.csproj]",
    "/src/Infrastructure/Notifications/TelegramPollingService.cs(233,77): error CS8619: Nullability of reference types in value doesn't match target type. [/src/Infrastructure/Infrastructure.csproj]",
  ]
  const out = [...errs, "Build FAILED.", ...errs, "    2 Error(s)"].join("\n")
  const s = summarizeOutput(out, "")
  assert.equal(s.diagnostics?.errors, 2)
  assert.deepEqual(s.diagnostics?.codes, { CS8604: 1, CS8619: 1 })
  assert.equal(s.output.filter((l) => l.includes("CS8604")).length, 1)
  assert.equal(s.omitted, 0)
  assert.equal(s.fullOutput, undefined)
})

test("output with no diagnostics has no diagnostics section", () => {
  const s = summarizeOutput("Unhandled exception. System.Exception: boom\n   at Program.Main()", "")
  assert.equal(s.diagnostics, undefined)
  assert.deepEqual(s.output, ["Unhandled exception. System.Exception: boom"])
})

test("a single file keeps its directory; only the mount point is trimmed", () => {
  const d = summarizeOutput("/src/Domain/BlogPosts/Slugs.cs(22,9): error WHITESPACE: Fix whitespace formatting.", "").diagnostics!
  assert.equal(d.files[0].path, "Domain/BlogPosts/Slugs.cs")
})

test("relative paths are left as they are", () => {
  const d = summarizeOutput("src/Api/Program.cs(1,1): error CS1002: ; expected", "").diagnostics!
  assert.equal(d.files[0].path, "src/Api/Program.cs")
})
