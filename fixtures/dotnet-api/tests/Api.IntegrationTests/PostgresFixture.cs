using Testcontainers.PostgreSql;

namespace Api.IntegrationTests;

/// <summary>
/// One test fixture, two transports (decision D2 in docs/v1-plan.md).
///
/// In the pipeline, Dagger starts PostgreSQL as a service and binds it as
/// ConnectionStrings__Test — Testcontainers inside a Dagger container would need a Docker
/// socket, which breaks the isolation the pipeline exists to provide.
///
/// On a developer laptop the variable is absent and Testcontainers starts a container.
/// The tests themselves cannot tell the difference.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private PostgreSqlContainer? _container;

    public string ConnectionString { get; private set; } = "";

    public async Task InitializeAsync()
    {
        var injected = Environment.GetEnvironmentVariable("ConnectionStrings__Test");
        if (!string.IsNullOrWhiteSpace(injected))
        {
            ConnectionString = injected;
            return;
        }

        // The image goes to the constructor: the parameterless overload is obsolete, and
        // the pre stage builds with -warnaserror, so using it fails the build.
        _container = new PostgreSqlBuilder("postgres:17-alpine")
            .WithDatabase("app_test")
            .WithUsername("postgres")
            .WithPassword("postgres")
            .Build();

        await _container.StartAsync();
        ConnectionString = _container.GetConnectionString();
    }

    public async Task DisposeAsync()
    {
        if (_container is not null) await _container.DisposeAsync();
    }
}

[CollectionDefinition(nameof(PostgresCollection))]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;
