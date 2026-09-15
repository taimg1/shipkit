using System.Reflection;
using Infrastructure;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Migrations are applied by the pipeline, never here. There is no Database.Migrate() call
// in this file, and there must never be one — see the repo CLAUDE.md.
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Default")
                ?? "Host=localhost;Database=app;Username=postgres;Password=postgres"));

var app = builder.Build();

// The commit SHA is baked in at publish time via -p:InformationalVersion.
// `verify` compares this value against the SHA it just deployed: a 200 carrying the
// PREVIOUS version is a failed deploy that would otherwise look green.
var version = Assembly.GetEntryAssembly()
    ?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
    ?.InformationalVersion ?? "unknown";

// Liveness, and the deploy contract. Deliberately touches nothing: `verify` compares this
// version against the SHA it just deployed, and a database blip must not fail a good deploy.
app.MapGet("/health", () => Results.Ok(new { status = "ok", version }));

// Readiness. This is the one monitoring should watch.
//
// Found during a restore drill: with the schema destroyed, /health still answered 200 while
// the application could serve nothing. Watching only /health means a dead database pages
// nobody.
app.MapGet("/health/ready", async (AppDbContext db) =>
{
    try
    {
        await db.Database.ExecuteSqlRawAsync("select 1");
        return Results.Ok(new { status = "ready", version });
    }
    catch (Exception ex)
    {
        return Results.Json(
            new { status = "unavailable", version, error = ex.GetType().Name },
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapGet("/orders", async (AppDbContext db) => await db.Orders.ToListAsync());

app.Run();

/// Exposed so the integration tests can use WebApplicationFactory.
public partial class Program;
