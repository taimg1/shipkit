import { test } from "node:test"
import assert from "node:assert/strict"
import { newestMigrationId, parseKitRef } from "../bin/lib.mjs"

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
