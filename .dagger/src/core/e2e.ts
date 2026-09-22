import { dag, Container, Directory, Secret, Service } from "@dagger.io/dagger"
import { Config } from "../config.js"
import { StackAdapter, TestSummary } from "../adapters/types.js"
import { APP_NAME, BASE_URL_VAR, DEFAULT_INIT_PATH, E2eConfig, E2eService, READY_TIMEOUT } from "../e2e-config.js"
import { ShipkitError, configError, notImplemented } from "../errors.js"
import { StageDetail, execOutput, withDetail } from "../report.js"
import { summarizeOutput } from "./output.js"
import { e2eNoSummary, e2eNotReady, e2eTimedOut, noTestsRan, testsFailed } from "./gates.js"
import { DEFAULT_REGISTRY_USER } from "./registry.js"

/**
 * The `e2e` stage: serve the image that was just built, start whatever the tests depend on,
 * and run the project's own browser suite against it.
 *
 * It runs after `build` because it needs that image — not a rebuild, not a copy, the container
 * the same run produced. The URL the tests get is the one the kit serves; nothing in the
 * project chooses it, so a suite cannot quietly pass by hitting a developer's localhost.
 *
 * What this file must not learn is what any of the services ARE (ADR 0008). It pulls images,
 * binds names, mounts a file at one fixed path, and waits for a port to answer. There is no
 * branch here for "a database" — the seed is a file, the readiness check is a socket, and both
 * work the same for a queue, a cache or a second API.
 *
 * The stack-specific half — putting the project's dependencies into the browsers image — is
 * `adapter.e2e` (adapters/types.ts).
 */

/**
 * Readiness is this file's, not Dagger's.
 *
 * Dagger runs an image's own HEALTHCHECK when it starts it as a service, and fails the service
 * if it does not pass. The fixture's is `--start-period=10s --retries=3`, which is tuning for a
 * running deployment; against a container that had just been created every run failed with
 * "health check errored: exit code: 1 … Connection refused" before the wait loop below ran at
 * all — the stage reported Docker's message instead of the kit's, and how long is long enough
 * was the Dockerfile's to decide.
 *
 * So the declared healthcheck is dropped for the length of this stage and the kit waits
 * instead: one budget (READY_TIMEOUT) for every service, whether its image declares a
 * healthcheck or not, and one message when it runs out. Nothing about the image that gets
 * published changes — this is a container derived from it, for this stage only.
 */
/** Printed by the wait loop so the failure can be told apart from a test failure. */
const READY_MARKER = "shipkit: did not answer in time:"
/** Printed when the command outlives `e2e.timeout`; `timeout` exits 124 for it. */
const TIMEOUT_MARKER = "shipkit: the e2e command ran out of time"

export async function e2eStage(
  source: Directory,
  cfg: Config,
  e2e: E2eConfig,
  adapter: StackAdapter,
  image: Container,
  registry: { token?: Secret; user?: string } = {},
): Promise<StageDetail<TestSummary>> {
  if (!adapter.e2e || !adapter.parseE2eSummary) {
    // Unreachable through loadConfig, which refuses `e2e:` for a stack whose adapter has none
    // (adapters/requirements.ts). Kept so this is never the thing that decides silently.
    throw configError(
      `the ${adapter.name} adapter has no e2e stage`,
      "Remove the e2e: block, or add the stage to that adapter. A configured stage that did " +
        "nothing would be a gate the project believes it has.",
    )
  }

  const unresolved = e2e.services.find((s) => s.fromHealth !== undefined)
  if (unresolved) {
    // Parsed, so the shape is settled and a project can be written against it; refused here,
    // because resolving a tag from a live deployment is not built. Exit 5, never a fallback:
    // a service silently pulled as `latest` is the moving target this field exists to avoid.
    throw notImplemented(`e2e.services["${unresolved.name}"].fromHealth`, "the next e2e milestone")
  }

  // Started once and bound twice. A service binding belongs to the container it is made on, so
  // binding only the runner left the application resolving nothing: the page under test failed
  // with "getaddrinfo ENOTFOUND db" while the tests could reach the same database perfectly
  // well. The app needs its dependencies as much as the suite does.
  const dependencies = e2e.services.map((s) => ({ name: s.name, service: serviceFor(source, cfg, s, registry) }))
  const bind = <T extends { withServiceBinding(alias: string, service: Service): T }>(c: T): T =>
    dependencies.reduce((acc, d) => acc.withServiceBinding(d.name, d.service), c)

  let served = bind(image)
  for (const [name, value] of Object.entries(e2e.env)) served = served.withEnvVariable(name, value)
  const app = served.withoutDockerHealthcheck().withExposedPort(e2e.port).asService({ useEntrypoint: true })
  const baseUrl = `http://${APP_NAME}:${e2e.port}`

  let runner = bind(adapter.e2e(browsersImage(cfg, e2e, registry), source, cfg)).withServiceBinding(APP_NAME, app)
  // The one way the command learns where to look. Set last, so nothing the adapter did can
  // shadow it, and refused in `env` so nothing the project wrote can either.
  runner = runner.withEnvVariable(BASE_URL_VAR, baseUrl)

  const script = runScript(e2e)
  let raw: string
  try {
    raw = await runner.withExec(["sh", "-c", script]).stdout()
  } catch (err) {
    // Not a command that ran and said no: the engine, an image pull, the network. That is
    // infrastructure, and turning it into a gate failure would blame the project for it.
    const out = execOutput(err)
    if (out === null) throw err
    if (out.includes(TIMEOUT_MARKER)) throw explain(e2eTimedOut(e2e.timeout, e2e.command), e2e, out)
    const late = out.split("\n").find((l) => l.includes(READY_MARKER))
    if (late) {
      throw explain(e2eNotReady(late.slice(late.indexOf(READY_MARKER) + READY_MARKER.length).trim()), e2e, out)
    }
    // A failing suite exits non-zero and still printed its counts. "3 of 40 failed" is worth a
    // round trip more than "exit code: 1" is — and the counts are read on this path too,
    // because Playwright exits 1 for "No tests found" and the reason for that is not "exit 1".
    const problem = verdict(adapter.parseE2eSummary(out), e2e)
    // Counts that all look fine and a command that still exited non-zero: the run failed after
    // the tests, or outside them. Dagger's own error says more about that than a summary would.
    if (!problem) throw err
    throw explain(problem, e2e, out)
  }

  // Zero tests is a failure for the same reason it is in `test`: a suite that discovered
  // nothing exits 0, and a green gate that checked nothing is the worst kind of green.
  const summary = adapter.parseE2eSummary(raw)
  const problem = verdict(summary, e2e)
  if (problem) throw explain(problem, e2e, raw)

  return withDetail(summary!, {
    command: e2e.command,
    baseUrl,
    tests: summary,
    services: e2e.services.map((s) => s.name),
  })
}

/**
 * One shell run: wait for everything, then the project's command, then the counts on stdout.
 *
 * One exec and not three, because Dagger starts a bound service for the exec that uses it.
 * Waiting in one exec and testing in the next would let the services be torn down and started
 * again in between — which would re-run a database's seed and make the readiness check a
 * statement about a container that is no longer there.
 */
function runScript(e2e: E2eConfig): string {
  const targets = [
    { name: APP_NAME, port: e2e.port, ready: e2e.ready },
    ...e2e.services.map((s) => ({ name: s.name, port: s.port, ready: s.ready })),
  ]
  const waits = targets.map((t) => `shipkit_ready ${t.name} ${t.port} '${t.ready ?? ""}' || exit 1`)

  return [
    // Everything on one stream: the core reads stdout, and which stream a runner prints its
    // summary on is not a thing to depend on.
    "exec 2>&1",
    READY_FUNCTION,
    ...waits,
    `timeout ${e2e.timeout} sh -c '${shellQuote(e2e.command)}'`,
    "code=$?",
    `[ $code -eq 124 ] && echo "${TIMEOUT_MARKER} (${e2e.timeout}s)"`,
    "exit $code",
  ].join("\n")
}

/**
 * Readiness, without knowing what answers.
 *
 * With a path it is HTTP: 2xx and nothing else. Without one it is a TCP connect, expressed
 * through the same curl — 6 is "no such host yet", 7 is "nothing listening", 28 is "listening
 * and mute". Anything else means something accepted the connection and said something back,
 * which is as much as the core can honestly claim about a service whose protocol it does not
 * know. A database hangs up on an HTTP request; that hang-up is the proof.
 */
const READY_FUNCTION = [
  "shipkit_ready() {",
  `  end=$(( $(date +%s) + ${READY_TIMEOUT} ))`,
  "  while :; do",
  '    if [ -n "$3" ]; then',
  `      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$1:$2$3" 2>/dev/null) || code=000`,
  '      case "$code" in 2??) return 0 ;; esac',
  "    else",
  '      curl -s -o /dev/null --max-time 5 "http://$1:$2/" 2>/dev/null',
  "      case $? in 6|7|28) ;; *) return 0 ;; esac",
  "    fi",
  '    [ "$(date +%s)" -ge "$end" ] && break',
  "    sleep 1",
  "  done",
  `  echo "${READY_MARKER} $1:$2$3 (${READY_TIMEOUT}s)"`,
  "  return 1",
  "}",
].join("\n")

/** The browsers image the project named, pinned by digest (e2e-config.ts). */
function browsersImage(cfg: Config, e2e: E2eConfig, registry: { token?: Secret; user?: string }): Container {
  return pull(e2e.image, cfg, registry)
}

/**
 * One declared service: the image, its environment, its seed file, its port.
 *
 * The file is mounted rather than copied in so it is there when the image's own startup looks
 * for it. The kit never reads it and never runs it — which is what keeps this function free
 * of any opinion about what the service is.
 */
function serviceFor(
  source: Directory,
  cfg: Config,
  s: E2eService,
  registry: { token?: Secret; user?: string },
): Service {
  let c = pull(s.image, cfg, registry)
  for (const [name, value] of Object.entries(s.env)) c = c.withEnvVariable(name, value)
  if (s.initSql) c = c.withMountedFile(DEFAULT_INIT_PATH, source.file(s.initSql))
  return c.withoutDockerHealthcheck().withExposedPort(s.port).asService({ useEntrypoint: true })
}

/**
 * A pull, with the run's registry credential attached only when the image is from the
 * project's own registry.
 *
 * Attaching it to every pull would send the project's token to Docker Hub and to Microsoft
 * because a Playwright image happens to be in the same list. A credential goes to the host it
 * belongs to and to no other.
 */
function pull(address: string, cfg: Config, registry: { token?: Secret; user?: string }): Container {
  const host = registryHost(address)
  let c = dag.container()
  if (registry.token && cfg.registry && host === registryHost(cfg.registry)) {
    c = c.withRegistryAuth(host, registry.user && registry.user.length > 0 ? registry.user : DEFAULT_REGISTRY_USER, registry.token)
  }
  return c.from(address)
}

/** Docker's rule: the first component is a host only when it has a dot or a port. */
function registryHost(address: string): string {
  const first = address.split("/")[0]
  return /[.:]/.test(first) || first === "localhost" ? first : "docker.io"
}

/**
 * What a set of counts means, in one place, because the run is judged on two paths: the command
 * exited zero, or it exited non-zero and its output still carries the counts. Playwright exits
 * 1 for "No tests found" and 0 for the same thing under --pass-with-no-tests, so a rule that
 * lived on only one path would let one of those through.
 *
 * Null when the run is a pass.
 */
function verdict(summary: TestSummary | null, e2e: E2eConfig): ShipkitError | null {
  if (!summary) return e2eNoSummary(e2e.command)
  if (summary.failed > 0) return testsFailed(summary)
  if (summary.total === 0) return noTestsRan("the runner found no tests")
  return null
}

/**
 * Puts the run's own output on the failing stage entry.
 *
 * A gate failure carries no ExecError, so without this the report said "2 of 2 test(s) failed"
 * and nothing else: which test, and what it saw, were in a container log the reader no longer
 * has. Dagger reports a failing `withExec` that way for free; a gate the kit raises itself has
 * to do it.
 */
function explain<E extends ShipkitError>(err: E, e2e: E2eConfig, output: string): E {
  err.detail = { command: e2e.command, ...summarizeOutput(output, "", 40) }
  return err
}

/** For a command embedded in a single-quoted shell word. */
const shellQuote = (s: string) => s.replace(/'/g, `'\\''`)
