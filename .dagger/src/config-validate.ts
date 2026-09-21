import type { Config, Environment } from "./config.js"

/**
 * The shape every shell-bound value in shipkit.yaml must have — pure, so it is tested without
 * Dagger.
 *
 * These values end up in commands run on the operator's machine and on the server. They are
 * quoted wherever they are used, and they are checked here as well: shipkit.yaml changes in
 * pull requests, and a host of `x;curl …|sh` should be a config error in review, not the one
 * value a missed quote lets through during `deploy --plan`. A name that is legal elsewhere
 * but not here is a smaller problem than a name that is a command.
 *
 * This file answers one question — is the value safe in a command line — and not what it
 * means. `stackVersion` is a target framework on one stack and a Node version on another;
 * which of those it has to look like belongs to adapters/requirements.ts, and is checked
 * there. Both run on every load.
 *
 * Problems are returned, not thrown, so this file imports nothing and the tests can load it.
 */

export interface ConfigProblem {
  message: string
  next: string
}

class Invalid extends Error {
  problem: ConfigProblem
  constructor(problem: ConfigProblem) {
    super(problem.message)
    this.problem = problem
  }
}

const invalid = (message: string, next: string) => new Invalid({ message, next })

/** A hostname, an IPv4 address or a bare IPv6 address. Never starts with `-`: ssh reads that as an option. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/
/** A POSIX login name. */
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/
/** A Docker container or network name, and Kamal's service name. */
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
/** A PostgreSQL role or database name, as the tools accept it on the command line. */
const PG_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/
/** An absolute URL path with an optional plain query string. */
const HEALTH_PATH = /^\/[A-Za-z0-9._~%/-]*(?:\?[A-Za-z0-9._~%=&-]*)?$/
/** URL characters, minus everything a shell treats as a quote, an expansion or an escape. */
const URL_CHARS = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!&()*+,;=%-]+$/
/** A runtime identifier, as .NET writes them and as core/platform.ts reads them. */
const RID = /^[a-z0-9][a-z0-9.-]{0,63}$/
/** A bare version token — `10.0`, `22`, `22.11.0` — and nothing a shell would act on. */
const VERSION = /^[0-9][0-9.]{0,15}$/

/** The first shell-bound field with an unacceptable value, or null when there is none. */
export function configProblem(cfg: Config): ConfigProblem | null {
  try {
    checkConfig(cfg)
    return null
  } catch (e) {
    if (e instanceof Invalid) return e.problem
    throw e
  }
}

function checkConfig(cfg: Config): void {
  check("service", cfg.service, DOCKER_NAME, "letters, digits, . _ - (as in config/deploy.yml)", true)
  check("health", cfg.health, HEALTH_PATH, "an absolute path such as /health")
  check("stackVersion", cfg.stackVersion, VERSION, "a version, such as 10.0 for .NET or 22 for Node")
  check("targetArch", cfg.targetArch, RID, "a runtime identifier, such as linux-x64")
  for (const [name, env] of Object.entries(cfg.environments)) checkEnvironment(name, env)
}

function checkEnvironment(name: string, env: Environment): void {
  const field = (key: string) => `environments.${name}.${key}`

  let parsed: URL | null = null
  try {
    parsed = new URL(env.url)
  } catch {
    // reported below
  }
  if (!parsed || !URL_CHARS.test(env.url)) {
    throw invalid(
      `shipkit.yaml: ${field("url")} is not a usable URL: ${JSON.stringify(env.url)}`,
      "An http:// or https:// URL without spaces, quotes, backslashes, backticks or $.",
    )
  }

  if (!Number.isInteger(env.sshPort) || env.sshPort < 1 || env.sshPort > 65535) {
    throw invalid(
      `shipkit.yaml: ${field("sshPort")} must be a whole number from 1 to 65535`,
      "A plain number, such as 22.",
    )
  }

  if (env.host !== undefined) {
    check(field("host"), env.host, HOST, "a hostname or an IP address")
    check(field("sshUser"), env.sshUser, USER, "a login name such as deploy")
  }
  if (env.dbContainer !== undefined) {
    check(field("dbContainer"), env.dbContainer, DOCKER_NAME, "a Docker container name")
  }
  check(field("network"), env.network, DOCKER_NAME, "a Docker network name")
  check(field("database"), env.database, PG_NAME, "a PostgreSQL database name")
  check(field("dbUser"), env.dbUser, PG_NAME, "a PostgreSQL role name")
}

function check(field: string, value: unknown, shape: RegExp, expected: string, optional = false) {
  if (optional && value === "") return
  if (typeof value !== "string" || !shape.test(value)) {
    throw invalid(
      `shipkit.yaml: ${field} has an unsafe or malformed value: ${JSON.stringify(value)}`,
      `Expected ${expected}. These values are used in shell commands, so nothing else is accepted.`,
    )
  }
}
