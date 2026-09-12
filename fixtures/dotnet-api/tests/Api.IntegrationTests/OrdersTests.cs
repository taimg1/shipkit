using Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Api.IntegrationTests;

/// <summary>
/// Tests run against a real PostgreSQL. Mocking the DbContext would prove nothing about
/// whether a change is safe for a database-heavy application.
/// </summary>
[Collection(nameof(PostgresCollection))]
public class OrdersTests(PostgresFixture pg)
{
    private AppDbContext NewContext()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(pg.ConnectionString)
            .Options;
        return new AppDbContext(options);
    }

    [Fact]
    public async Task Migrations_apply_to_an_empty_database()
    {
        await using var db = NewContext();
        // Calling Migrate() here is fine: this is a test, applying migrations to a scratch
        // database. The rule it must never break is Database.Migrate() at APPLICATION
        // startup — see the repo CLAUDE.md.
        await db.Database.MigrateAsync();

        var applied = await db.Database.GetAppliedMigrationsAsync();
        Assert.NotEmpty(applied);
    }

    [Fact]
    public async Task An_order_survives_a_round_trip()
    {
        await using var db = NewContext();
        await db.Database.MigrateAsync();

        var reference = $"ORD-{Guid.NewGuid():N}"[..12];
        db.Orders.Add(new Order
        {
            Reference = reference,
            Total = 42.50m,
            CreatedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync();

        var found = await db.Orders.SingleOrDefaultAsync(o => o.Reference == reference);
        Assert.NotNull(found);
        Assert.Equal(42.50m, found.Total);
    }
}
