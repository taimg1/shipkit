# Multi-stage: the SDK never reaches the runtime image.
# The kit builds this file; it does not template it — the Dockerfile belongs to the project
# (docs/multi-stack-plan.md §5).

ARG DOTNET_VERSION=10.0

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS build
ARG GIT_SHA=dev
WORKDIR /src

# Restore first, with only the project files present, so that a source-only change does not
# invalidate the restore layer.
COPY Fixture.slnx ./
COPY src/Api/Api.csproj src/Api/
COPY src/Infrastructure/Infrastructure.csproj src/Infrastructure/
COPY tests/Api.IntegrationTests/Api.IntegrationTests.csproj tests/Api.IntegrationTests/
RUN dotnet restore src/Api/Api.csproj

COPY . .
# The SHA is baked in here and reported by /health. `verify` compares it against the SHA it
# just deployed, so a stale container cannot pass as a successful release.
RUN dotnet publish src/Api/Api.csproj \
      -c Release \
      -o /app \
      --no-restore \
      -p:InformationalVersion=${GIT_SHA}

FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_VERSION} AS runtime
WORKDIR /app

# curl is here only for HEALTHCHECK. The pipeline's `verify` stage checks health from
# outside the container over HTTP, so this is a convenience for compose and for kamal-proxy,
# not the gate itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app .

# The image's own unprivileged user. Never run the app as root.
USER $APP_UID

ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

# No migration runs here. Ever. Migrations are applied by the pipeline.
ENTRYPOINT ["dotnet", "Api.dll"]
