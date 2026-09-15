# Add a migration without losing data

The build is not where this stack hurts. This is.

## The loop

```bash
dotnet ef migrations add <Name> --project src/Infrastructure --startup-project src/Api
dotnet build                      # `migrations add` does NOT rebuild, and a stale assembly
                                  # produces an empty script that passes every gate
shipkit db lint                   # seconds, not a full ci run
```

Then read the generated SQL. Not the C#, the SQL — the two do not always say the same thing.

## What the gates will stop, and why

**A plain `CREATE INDEX`.** It blocks writes for the duration: instant on an empty client
database, minutes of downtime on a table with a year of data. Write it by hand:

```csharp
migrationBuilder.Sql(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_created_at ON orders (created_at);",
    suppressTransaction: true);
```

`suppressTransaction` is required — `CONCURRENTLY` cannot run inside a transaction and EF
wraps migrations in one.

**A renamed property.** EF sometimes emits `RENAME COLUMN` and sometimes `DROP` + `ADD`. The
second silently destroys the column's data while CI stays green. Both are refused: even a
correct rename breaks the old application version during a zero-downtime swap, when both
versions run at once.

**Anything that drops or rewrites.** `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN ... TYPE`,
`SET NOT NULL` on a populated column, a foreign key without `NOT VALID`.

## Destructive changes: split them across releases

Never in one release:

1. **N** — add the new column, write to both, read from the old.
2. **N+1** — read from the new, stop writing the old.
3. **N+2** — drop the old column.

By N+2 the column holds nothing anyone reads, and a rollback to N+1 still works.

## When the destruction really is intended

Name it, in the migration, where a reviewer will see it:

```csharp
migrationBuilder.Sql("-- shipkit:allow-loss orders.CreatedAt  superseded by CreatedOn in release N+1");
```

The marker must name the exact table or column. It waives that one loss and nothing else — a
second, unintended drop in the same migration is still refused. A marker that waives nothing
fails the build, so they cannot be added preemptively.

The run still prints what it permitted, with the row count behind it:

```
acknowledged: ['column "orders.CreatedAt" no longer exists (its table held 3 row(s) before the migration)']
```

## Keep the seed honest

`ci/seed.sql` is what `apply-to-copy` protects: it populates a copy of the deployed schema so
the migration's effect on real rows is observable. A seed that does not cover a table means
that table's data is not being checked. Add rows to it when you add tables.

## Never

```csharp
app.Services.GetRequiredService<AppDbContext>().Database.Migrate();  // no
```

Two instances race, the application needs DDL privileges forever, nothing gets inspected
first, and a failure happens at boot in front of users with no way back.
