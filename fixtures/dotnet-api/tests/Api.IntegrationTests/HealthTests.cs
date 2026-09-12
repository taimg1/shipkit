using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Api.IntegrationTests;

/// <summary>
/// /health is a contract the pipeline depends on: `verify` compares the version it reports
/// against the SHA that was just deployed. A 200 carrying the previous version is a failed
/// deploy that would otherwise look green, so the shape of this response is load-bearing.
/// </summary>
public class HealthTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public HealthTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private record HealthResponse(string Status, string Version);

    [Fact]
    public async Task Health_returns_ok_and_a_version()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<HealthResponse>();
        Assert.NotNull(body);
        Assert.Equal("ok", body.Status);
        Assert.False(string.IsNullOrWhiteSpace(body.Version));
    }
}
