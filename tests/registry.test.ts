import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_REGISTRY_USER,
  pushFailureHint,
  registryProblem,
} from "../.dagger/src/core/registry.ts"

// Every shape below was published for real against a local registry:2 that required a
// password (docs/runbooks/registry.md). Each one failed with "invalid reference format" —
// reported as exit 3, infrastructure's fault, for a value somebody typed in shipkit.yaml.
test("a registry a client would actually write is accepted", () => {
  for (const registry of [
    "ghcr.io/taimg1/shipkit-fixture",
    "ghcr.io/owner/some.app_name",
    "registry.example.com:5000/team/app",
    "localhost:5601/smoke",
    "docker.io/owner/app",
    "ghcr.io/owner/deep/path/app",
  ]) {
    assert.equal(registryProblem(registry), null, registry)
  }
})

test("a registry with no repository path is refused: it would publish as <host>:<tag>", () => {
  const p = registryProblem("host.docker.internal:5601")
  assert.match(p!.message, /names no repository/)
})

// The one that looks right and is not: a capital letter in an organisation name.
test("an uppercase repository is refused, as the registry itself would", () => {
  assert.match(registryProblem("host.docker.internal:5601/Smoke")!.message, /not a repository name/)
  assert.match(registryProblem("ghcr.io/Acme/app")!.message, /not a repository name/)
})

test("a registry that already carries a tag or a digest is refused", () => {
  assert.match(registryProblem("ghcr.io/owner/app:latest")!.message, /carries a tag/)
  assert.match(registryProblem(`ghcr.io/owner/app@sha256:${"a".repeat(64)}`)!.message, /carries a digest/)
})

test("empty path segments are refused", () => {
  for (const registry of ["ghcr.io/owner/app/", "ghcr.io//app", "ghcr.io/"]) {
    assert.match(registryProblem(registry)!.message, /empty path segment|names no repository/, registry)
  }
})

// Docker reads a first component without a dot, a port or the name localhost as a Docker Hub
// namespace. withRegistryAuth would then register the token for a host nothing contacts, and
// the push would go out unauthenticated — a 401 whose cause is nowhere in the message.
test("a first component that is not a host is refused", () => {
  const p = registryProblem("myorg/app")
  assert.match(p!.message, /does not start with a registry host/)
  assert.match(p!.next, /Docker Hub namespace/)
})

test("no registry at all is still a configuration error", () => {
  assert.match(registryProblem("")!.message, /no registry configured/)
  assert.match(registryProblem(" ")!.message, /whitespace/)
})

// A 401 from a registry that requires a password is as often the username as the token, and
// the username was the one nobody chose: it defaulted to "shipkit" with no way to change it
// outside GitHub Actions, so a correct token failed and the advice was to check the token.
test("the failure hint names the user the token was sent as", () => {
  const hint = pushFailureHint("shipkit-ci", "ghcr.io")
  assert.match(hint, /"shipkit-ci"/)
  assert.match(hint, /ghcr\.io/)
  assert.match(hint, /SHIPKIT_REGISTRY_USER/)
})

test("without a token the hint says so instead of blaming the permissions", () => {
  const hint = pushFailureHint(undefined, "ghcr.io")
  assert.match(hint, /No registry token/)
  assert.match(hint, /SHIPKIT_REGISTRY_TOKEN/)
})

test("the fallback username is a value, not an empty string", () => {
  assert.equal(DEFAULT_REGISTRY_USER, "shipkit")
})
