/**
 * `e2e:` from shipkit.yaml — pure, so the rules that decide what the browser tests run against
 * can be tested without Dagger (the same reason build-args.ts and adapters/requirements.ts are
 * split out).
 *
 * The block is optional. A project without it has no `e2e` stage and pays nothing for one: no
 * browsers image is pulled and no service is started. The stage still appears in the report,
 * skipped with "not configured", because a gate nobody can see in the report has stopped being
 * a gate (ADR 0004). `services:` is optional too — a suite that only checks layout, overflow,
 * broken images and the console needs nothing running but the site.
 *
 * Two things here are the project's to state and are deliberately not defaulted:
 *
 *  - **Image versions.** The browsers image and every service image name a version. A floating
 *    tag is refused at config load: `latest` today and `latest` next month are two different
 *    runs of one commit, which is the whole reason core/images.ts pins the kit's own images by
 *    digest. A digest is allowed here too, and recommended. The browsers image is not pinned in
 *    the kit because it is not the kit's — it has to match the `@playwright/test` the project
 *    locks, and a mismatch is a suite that fails for reasons the change did not cause.
 *  - **Data.** A service that needs rows names the SQL file they come from (`initSql`). An
 *    empty database answers every query with no rows, so the site under test returns 200 with
 *    empty pages and the suite goes green having proved nothing. There is no default seed for
 *    the same reason there is no default readiness path: guessing one produces a passing test
 *    of the wrong thing.
 */

export interface E2eService {
  /** The hostname the app and the tests reach this service on. A DNS label, not a free string. */
  name: string
  /** Image with an explicit tag or digest. A floating tag is refused — see the file comment. */
  image: string
  /** The port the service listens on; also the port readiness is checked against. */
  port: number
  env: Record<string, string>
  /**
   * An HTTP path that answers 2xx once the service is up. Absent means readiness is a TCP
   * connect instead — which is all the core can honestly check for something that does not
   * speak HTTP (ADR 0008: it starts images and binds names, it does not know what they are).
   * A database has no such path, so this cannot be required of every service.
   */
  ready?: string
  /**
   * A file in the repository, given to the service when it starts. The kit mounts it at
   * DEFAULT_INIT_PATH — the directory the postgres, mysql and mariadb images run on first boot
   * — and never reads or executes it itself.
   */
  initSql?: string
  /**
   * A health endpoint of a running deployment, whose reported commit names the image tag to
   * use, in place of pinning one here. PARSED BUT NOT IMPLEMENTED: core/e2e.ts refuses it with
   * exit 5 rather than falling back to anything, the same way `delivery: static` is refused.
   *
   * It exists so a frontend repository does not have to pin a backend commit. When it is built
   * it resolves once at the start of the stage and writes the resolved tag AND digest into the
   * report, so a run can be read back afterwards, and it fails closed: an endpoint that cannot
   * be read, or that reports something which is not a commit, fails the stage.
   */
  fromHealth?: string
}

export interface E2eConfig {
  /** The project's own command, e.g. `npx playwright test`. Run by the adapter's runner image. */
  command: string
  /** The browsers image the command runs in. See the file comment on versions. */
  image: string
  /** The port the built application image listens on. Never guessed: nothing else knows it. */
  port: number
  /** The path the built image answers 2xx on once it is serving. Waited for before the suite. */
  ready: string
  /** Seconds the command may take before the stage fails. */
  timeout: number
  /**
   * Environment the built image is served with, so it can reach the declared services by name.
   * In production Kamal supplies these; for the length of this stage the kit does.
   *
   * Public by construction, like `buildArgs`: it is in shipkit.yaml, in the report's reach and
   * in a container anyone can start. Secrets do not go here (ADR 0006).
   */
  env: Record<string, string>
  services: E2eService[]
}

export type E2eParse =
  | { ok: true; e2e: E2eConfig | null }
  | { ok: false; message: string; next: string }

/** Default for `timeout`: long enough for a real suite, short enough that a hang is not a hang. */
export const DEFAULT_E2E_TIMEOUT = 600
/** The most `timeout` may be. A gate that can wait forever is a stuck pipeline, not a gate. */
export const MAX_E2E_TIMEOUT = 3600
/** How long the core waits for the app and each service before giving up. */
export const READY_TIMEOUT = 120

/**
 * The variable the kit puts the base URL in. Fixed, not configurable: the project's suite reads
 * it, and one name across every project is one less thing for a suite to get silently wrong.
 * No SHIPKIT_ prefix for the same reason — it is the project's variable, not the kit's.
 */
export const BASE_URL_VAR = "E2E_BASE_URL"

/**
 * The name the built image is bound under. Reserved: a declared service of the same name would
 * silently replace the thing under test.
 *
 * Not "app", which is what this was until a browser explained why. `app` is a real gTLD and it
 * is on Chrome's HSTS preload list, so Chrome matched the single-label host against it, forced
 * https:// and failed every navigation with ERR_SSL_PROTOCOL_ERROR — while curl, which has no
 * preload list, talked to the same port over plain HTTP quite happily. Any name that is also a
 * preloaded TLD (`app`, `dev`, `page`, `new`…) has the same problem, which is why this one
 * carries a hyphen: no TLD can.
 */
export const APP_NAME = "shipkit-app"

/** Where `initSql` is mounted: what the postgres, mysql and mariadb images run on first boot. */
export const DEFAULT_INIT_PATH = "/docker-entrypoint-initdb.d/10-shipkit.sql"

/** Tags that name a moving target rather than a version. */
export const FLOATING_TAGS = ["latest", "main", "master", "edge"]

/** An environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A DNS label: the name becomes a hostname inside the run. */
const SERVICE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
/** An absolute URL path, as config-validate.ts accepts one for `health`. */
const PATH = /^\/[A-Za-z0-9._~%/-]*(?:\?[A-Za-z0-9._~%=&-]*)?$/
/** A digest, as a registry writes it. */
const DIGEST = /@sha256:[0-9a-f]{64}$/
/** A repository path inside the repository — never absolute, never climbing out of it. */
const REPO_FILE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/
/** An http(s) URL, with nothing a shell would act on. */
const URL_SHAPE = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!&()*+,;=%-]+$/

export function parseE2e(raw: unknown): E2eParse {
  if (raw === undefined || raw === null) return { ok: true, e2e: null }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return bad("e2e must be a mapping", EXAMPLE)
  }
  const c = raw as Record<string, unknown>

  const command = c.command
  if (typeof command !== "string" || command.trim().length === 0) {
    return bad("e2e.command is required", EXAMPLE)
  }
  // No allowlist of characters, unlike config-validate.ts: this value IS a command line, and
  // refusing the characters a command line is made of would refuse every real one. What is
  // checked is that it is one line — a second line would run unnoticed after the tests.
  if (/[\n\r\u0000]/.test(command)) {
    return bad(
      "e2e.command must be a single command line",
      "Put a multi-step run in a script the project owns and call that, e.g. command: npm run e2e.",
    )
  }

  const image = c.image
  if (typeof image !== "string" || image.length === 0) {
    return bad("e2e.image is required", EXAMPLE)
  }
  const browsers = imagePinProblem(image)
  if (browsers) return bad(`e2e.image ${browsers.message}`, browsers.next)

  const port = wholeNumber(c.port, 1, 65535)
  if (port === null) {
    return bad(
      "e2e.port is required and must be a port number",
      "The port the built image listens on, e.g. port: 3000. Nothing else in the kit knows it — " +
        "it is in the project's Dockerfile, and a guess would serve the tests a connection refused.",
    )
  }

  const ready = c.ready
  if (typeof ready !== "string" || !PATH.test(ready)) {
    return bad(
      "e2e.ready is required and must be an absolute path",
      "The path the built image answers 2xx on once it is serving, e.g. ready: /api/health. The " +
        "kit waits for it before the suite starts, so a site that never came up fails as that " +
        "rather than as a page of assertion errors.",
    )
  }

  const timeout = c.timeout === undefined ? DEFAULT_E2E_TIMEOUT : wholeNumber(c.timeout, 1, MAX_E2E_TIMEOUT)
  if (timeout === null) {
    return bad(
      `e2e.timeout must be a whole number of seconds between 1 and ${MAX_E2E_TIMEOUT}`,
      `Leave it out for the default of ${DEFAULT_E2E_TIMEOUT}.`,
    )
  }

  const appEnv = parseEnv(c.env, "e2e.env")
  if ("message" in appEnv) return appEnv

  const services = parseServices(c.services)
  if ("message" in services) return services

  return {
    ok: true,
    e2e: { command, image, port, ready, timeout, env: appEnv.env, services: services.list },
  }
}

function parseServices(raw: unknown): { list: E2eService[] } | { ok: false; message: string; next: string } {
  if (raw === undefined || raw === null) return { list: [] }
  if (!Array.isArray(raw)) {
    return bad("e2e.services must be a list", SERVICE_EXAMPLE)
  }

  const list: E2eService[] = []
  const seen = new Set<string>()
  for (const [i, entry] of raw.entries()) {
    const at = `e2e.services[${i}]`
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return bad(`${at} must be a mapping`, SERVICE_EXAMPLE)
    }
    const s = entry as Record<string, unknown>

    const name = s.name
    if (typeof name !== "string" || !SERVICE_NAME.test(name)) {
      return bad(
        `${at}.name is required and must be a hostname label`,
        "Lowercase letters, digits and hyphens, e.g. name: db. It is the name the app and the " +
          "tests reach this service by.",
      )
    }
    // The app under test is bound under this name. A service that took it would replace the
    // thing the suite is supposed to be testing, and every assertion would still pass or fail
    // for reasons nobody could see.
    if (name === APP_NAME) {
      return bad(
        `${at}.name cannot be "${APP_NAME}"`,
        `"${APP_NAME}" is the image the kit built and is serving to the tests. Name this one ` +
          "something else.",
      )
    }
    if (seen.has(name)) {
      return bad(`${at}.name "${name}" is declared twice`, "Names are hostnames; each one names one service.")
    }
    seen.add(name)

    const image = s.image
    if (typeof image !== "string" || image.length === 0) {
      return bad(`${at}.image is required`, SERVICE_EXAMPLE)
    }

    let fromHealth: string | undefined
    if (s.fromHealth !== undefined) {
      if (typeof s.fromHealth !== "string" || !URL_SHAPE.test(s.fromHealth)) {
        return bad(
          `${at}.fromHealth must be an http(s) URL`,
          "The health endpoint of a running deployment whose reported commit names the tag, " +
            "e.g. fromHealth: https://api.example.com/health.",
        )
      }
      // The tag is what fromHealth produces. One of the two, never both: a pinned tag next to a
      // resolver reads as if the pin won, and which one actually ran would be a guess.
      if (DIGEST.test(image) || hasTag(image)) {
        return bad(
          `${at}.image carries a tag and ${at}.fromHealth would resolve one`,
          "Name the repository only, e.g. image: ghcr.io/org/api, or remove fromHealth.",
        )
      }
      fromHealth = s.fromHealth
    } else {
      const pin = imagePinProblem(image)
      if (pin) return bad(`${at}.image ${pin.message}`, pin.next)
    }

    const port = wholeNumber(s.port, 1, 65535)
    if (port === null) {
      return bad(
        `${at}.port is required and must be a port number`,
        "The port this service listens on, e.g. port: 5432. It is what readiness is checked on.",
      )
    }

    const parsedEnv = parseEnv(s.env, `${at}.env`)
    if ("message" in parsedEnv) return parsedEnv

    let ready: string | undefined
    if (s.ready !== undefined) {
      if (typeof s.ready !== "string" || !PATH.test(s.ready)) {
        return bad(
          `${at}.ready must be an absolute path`,
          "For example ready: /healthz. Leave it out for a service that does not speak HTTP — " +
            "readiness is then a TCP connect.",
        )
      }
      ready = s.ready
    }

    let initSql: string | undefined
    if (s.initSql !== undefined) {
      if (typeof s.initSql !== "string" || !REPO_FILE.test(s.initSql) || s.initSql.split("/").includes("..")) {
        return bad(
          `${at}.initSql must be a path to a file in the repository`,
          "For example initSql: ci/e2e-seed.sql. Relative to the repository root, and inside it.",
        )
      }
      initSql = s.initSql
    }

    list.push({ name, image, port, env: parsedEnv.env, ready, initSql, fromHealth })
  }
  return { list }
}

/** Whether an image reference carries a tag (a colon after the last slash — not a registry port). */
function hasTag(image: string): boolean {
  const slash = image.lastIndexOf("/")
  const colon = image.lastIndexOf(":")
  return colon > slash
}

/**
 * Why an image is not pinned well enough to run in a gate, or null.
 *
 * A digest is accepted whatever the tag says. Without one the tag has to be explicit and it may
 * not be one of the names publishers move: the same commit would otherwise run against a
 * different image next month with nothing here changing.
 */
function imagePinProblem(image: string): { message: string; next: string } | null {
  if (DIGEST.test(image)) return null
  if (image.includes("@")) {
    return { message: `carries something that is not a sha256 digest: ${JSON.stringify(image)}`, next: PIN_NEXT }
  }
  if (!hasTag(image)) {
    return { message: `has no tag: ${JSON.stringify(image)}`, next: PIN_NEXT }
  }
  const tag = image.slice(image.lastIndexOf(":") + 1)
  if (FLOATING_TAGS.includes(tag)) {
    return { message: `is tagged "${tag}", which moves: ${JSON.stringify(image)}`, next: PIN_NEXT }
  }
  return null
}

const PIN_NEXT =
  "Name the version the project tested against, e.g. postgres:17-alpine, and pin it harder with " +
  `@sha256:… . A tag that moves (${FLOATING_TAGS.join(", ")}) makes one commit mean different ` +
  "runs, and the kit does not do that quietly."

function parseEnv(raw: unknown, at: string): { env: Record<string, string> } | { ok: false; message: string; next: string } {
  if (raw === undefined || raw === null) return { env: {} }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return bad(`${at} must be a mapping of NAME: value`, "For example:\n  env:\n    POSTGRES_PASSWORD: postgres")
  }
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_NAME.test(name)) {
      return bad(`${at}.${name} is not a usable environment variable name`, "Letters, digits and underscores, not starting with a digit.")
    }
    // The kit sets it, to the image it is serving. A project value would be overwritten, so it
    // is refused rather than silently ignored.
    if (name === BASE_URL_VAR) {
      return bad(
        `${at} must not set ${BASE_URL_VAR}`,
        `The kit sets ${BASE_URL_VAR} to the URL it serves the built image on. That is the one ` +
          "thing the tests may not be pointed elsewhere by.",
      )
    }
    // As in buildArgs: a number or a boolean is written out, a mapping has no sensible text.
    if (value === null || value === undefined || typeof value === "object") {
      return bad(
        `${at}.${name} must be a value, not ${value === null || value === undefined ? "empty" : "a mapping"}`,
        "Environment variables are strings; write the value out.",
      )
    }
    env[name] = String(value)
  }
  return { env }
}

/** YAML reads ports and timeouts as numbers; anything else is refused rather than coerced. */
function wholeNumber(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) return null
  return raw
}

const bad = (message: string, next: string): { ok: false; message: string; next: string } => ({
  ok: false,
  message: `shipkit.yaml: ${message}`,
  next,
})

const EXAMPLE =
  "For example:\n" +
  "  e2e:\n" +
  "    command: npx --no-install playwright test\n" +
  "    image: mcr.microsoft.com/playwright:v1.63.0-noble@sha256:…\n" +
  "    port: 3000\n" +
  "    ready: /api/health\n" +
  "    timeout: 600"

const SERVICE_EXAMPLE =
  "For example:\n" +
  "  e2e:\n" +
  "    services:\n" +
  "      - name: db\n" +
  "        image: postgres:17-alpine\n" +
  "        port: 5432\n" +
  "        env:\n" +
  "          POSTGRES_PASSWORD: postgres\n" +
  "        initSql: ci/e2e-seed.sql"
