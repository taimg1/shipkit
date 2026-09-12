using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Infrastructure;

/// <summary>
/// Lets `dotnet ef` build a model without a reachable database. The pipeline generates
/// migration SQL in a container that has no database at all, so this is what keeps the
/// `db` stage deterministic.
///
/// Generating SQL needs only a provider, not a connection — hence the placeholder host.
/// Commands that DO connect (`database update`, `migrations list` showing applied status)
/// pick up ConnectionStrings__Default when it is set, which is how the local development
/// loop works.
/// </summary>
public class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    private const string Placeholder =
        "Host=design-time-placeholder;Database=app;Username=postgres;Password=postgres";

    public AppDbContext CreateDbContext(string[] args)
    {
        var connectionString =
            Environment.GetEnvironmentVariable("ConnectionStrings__Default") ?? Placeholder;

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(connectionString)
            .Options;

        return new AppDbContext(options);
    }
}
