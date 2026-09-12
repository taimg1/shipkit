# M3 — what the `db` gate does, verified

Run against `fixtures/dotnet-api` on 2026-09-12, Dagger v0.21.9, squawk-cli 2.65.0,
EF Core 10.0.12, PostgreSQL 17. Every line below was observed, not predicted.

Command shape:

```
dagger call ci --source=./fixtures/dotnet-api --stage=db \
  --migration-base=20260912083112_InitialCreate
```

`--migration-base` is what production has already applied. The seed in `ci/seed.sql` puts
three rows in `orders` before the pending migration runs, which is what makes data loss
observable rather than theoretical.

## The checkpoint the whole gate rests on

The kit lints the **non-idempotent** script and applies the idempotent one. That split was an
assumption until this was measured, on one migration that drops a populated column:

| Script form | Squawk findings |
|---|---|
| non-idempotent | 3, including `ban-drop-column` |
| `--idempotent` (statements wrapped in `DO $EF$ ... END $EF$`) | **0** |

Squawk does not look inside `DO` blocks. Linting the idempotent script would have reported a
clean bill of health for a migration that destroys a column. The false green in
`ci-cd-plan.md` §7.2 is real, and it is total — not a degraded result, no result at all.

## Scenarios

| # | Migration | Result | Gate |
|---|---|---|---|
| A | `HasIndex` → plain `CREATE INDEX` | red, exit 1 | `require-concurrent-index-creation`, line 2 |
| B | Same index via `migrationBuilder.Sql(..., suppressTransaction: true)` with `CONCURRENTLY` | green, exit 0 | — |
| C | Property renamed; EF emitted `RenameColumn` | red, exit 1 | `renaming-column` |
| D | Same rename written as `DROP COLUMN` + `ADD COLUMN` | red, exit 1 | `ban-drop-column` |
| E | D plus `-- shipkit:allow-loss orders.CreatedAt` | green, exit 0 | loss reported, not fatal |
| F | D plus a marker naming a **different** column | red, exit 1 | `ban-drop-column` — the waiver did not apply |
| G | E plus a second marker naming a column nothing lost | red, exit 1 | `stale-allow-loss` |

Scenario E still prints what it permitted:

```
acknowledged: ['column "orders.CreatedAt" no longer exists (its table held 3 row(s) before the migration)']
```

A waiver that hides its own cost is not a waiver, it is a blindfold.

## Notes worth keeping

**EF Core 10 did not fall into the rename trap.** Renaming a property with no other change
produced `RenameColumn`, not `DROP` + `ADD` (scenario C). The trap in `ci-cd-plan.md` §7.3 is
real but did not reproduce on this version under these conditions; scenario D had to be
written by hand. Do not read that as "EF is safe now" — read it as "the conditions that
trigger it are narrower than the plan assumed, and are not yet characterised." The gate stays.

**Squawk fires first.** Its `ban-drop-column` catches what the grep scan was written to catch.
The grep scan is now a backstop for the case where a rule is excluded or Squawk is replaced,
which is the role it should have had from the start.

**A rename is a break even when it is correct.** Scenario C is a well-formed `RENAME COLUMN`
and is still refused, because during a zero-downtime swap the old and new application
versions run at the same time (ADR 0005, expand/contract). The gate is not wrong there.
