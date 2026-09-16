/**
 * What is on the deploy target before anything is planned — pure, so the rules that turn a
 * server's state into plan steps can be tested without one.
 *
 * The kit had only ever deployed to a host where `kamal setup` had been run by hand. On a fresh
 * server there is no database container, and the first stage, backup, failed reading it (#13).
 * And `kamal app version` failing for any reason read as "nothing deployed", so a server the kit
 * could not talk to looked like an empty one.
 */

export type ContainerState = "running" | "stopped" | "missing"

/**
 * What the server calls its own architecture, as a Docker platform.
 *
 * `docker info` says `x86_64`; `docker version` says `amd64`. Both spellings are accepted so
 * the probe is not hostage to which command answered.
 */
const PLATFORM_BY_SERVER_ARCH: Record<string, string> = {
  x86_64: "linux/amd64",
  amd64: "linux/amd64",
  aarch64: "linux/arm64",
  arm64: "linux/arm64",
  armv7l: "linux/arm/v7",
}

/**
 * The server's architecture as a Docker platform, or null when the answer is not one we know.
 *
 * Null is never treated as agreement — see `provisioning`. Failing to read this is the case the
 * check exists for, so it must not read as a pass.
 */
export function parseServerArch(output: string): string | null {
  const word = output.trim().split("\n").pop()?.trim() ?? ""
  return PLATFORM_BY_SERVER_ARCH[word] ?? null
}

export interface ServerState {
  /** Whether the SSH user can run docker at all. */
  docker: "ok" | "unavailable"
  proxy: ContainerState
  db: ContainerState
  /** Containers labelled with the service, running or not: has this app ever been deployed here. */
  appContainers: number
  /** The server's Docker platform, e.g. "linux/amd64", or null when it could not be read. */
  arch: string | null
  /** Exactly what the server said, for a message worth reading when arch is null. */
  archRaw: string
}

/**
 * A POSIX sh script that prints one `key:value` line per fact. Container names are passed in by
 * the caller from configuration and are shell-quoted here.
 */
export function serverProbeScript(service: string, dbContainer: string | undefined): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return [
    "if ! docker info >/dev/null 2>&1; then echo docker:unavailable; exit 0; fi",
    "echo docker:ok",
    `state() { s=$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null) || { echo missing; return; }; ` +
      `if [ "$s" = running ]; then echo running; else echo stopped; fi; }`,
    `echo proxy:$(state kamal-proxy)`,
    dbContainer ? `echo db:$(state ${q(dbContainer)})` : "echo db:missing",
    `echo app:$(docker ps -a -q --filter ${q(`label=service=${service}`)} | wc -l | tr -d ' ')`,
    // An image is built for one architecture and the server runs one; a deploy that gets this
    // wrong dies at release, after the migrations (#18).
    `echo arch:$(docker info --format '{{.Architecture}}' 2>/dev/null)`,
  ].join("\n")
}

export type ProbeResult = { ok: true; state: ServerState } | { ok: false; reason: string }

export function parseServerProbe(output: string): ProbeResult {
  const facts = new Map<string, string>()
  for (const line of output.split("\n")) {
    const m = /^(docker|proxy|db|app|arch):(\S*)$/.exec(line.trim())
    if (m) facts.set(m[1], m[2])
  }

  // Silence is not an empty server.
  if (!facts.has("docker")) return { ok: false, reason: "the server gave no answer" }
  if (facts.get("docker") === "unavailable") {
    return {
      ok: true,
      state: { docker: "unavailable", proxy: "missing", db: "missing", appContainers: 0, arch: null, archRaw: "" },
    }
  }

  const container = (v: string | undefined): ContainerState | null =>
    v === "running" || v === "stopped" || v === "missing" ? v : null
  const proxy = container(facts.get("proxy"))
  const db = container(facts.get("db"))
  const app = Number(facts.get("app"))
  if (!proxy || !db || !Number.isInteger(app)) {
    return { ok: false, reason: `the server's answer was incomplete: ${output.trim().replace(/\n/g, "; ")}` }
  }
  const archRaw = facts.get("arch") ?? ""
  return { ok: true, state: { docker: "ok", proxy, db, appContainers: app, arch: parseServerArch(archRaw), archRaw } }
}

export type Provisioning =
  | { ok: true; steps: string[] }
  | { ok: false; reason: string; next: string }

/**
 * What a deploy has to do to the server before it can deploy, or why it must not start.
 *
 * Steps are part of the plan, so the token covers them: booting a production database is a
 * change to production and is confirmed like one.
 *
 * `building` is the Docker platform the image will be built for, from core/platform.ts. It is
 * passed in rather than imported so this file stays testable without Dagger.
 */
export function provisioning(state: ServerState, needsDb: boolean, building: string): Provisioning {
  if (state.docker === "unavailable") {
    return {
      ok: false,
      reason: "docker is not available to the deploy user on the server",
      next:
        "Prepare the server first: Docker installed, and the SSH user in the docker group. " +
        "The kit deploys to a prepared server; it does not install system packages.",
    }
  }

  // Checked before anything else about the app, because getting it wrong is not caught until
  // release — by which time backup and migrate have run and the schema has already moved (#18).
  if (state.arch === null) {
    return {
      ok: false,
      reason: `the server did not say what architecture it runs (it answered "${state.archRaw || "nothing"}")`,
      next:
        "An unreadable architecture is not a matching one. Check `docker info` on the server, " +
        "then plan again.",
    }
  }
  if (state.arch !== building) {
    return {
      ok: false,
      reason: `the server runs ${state.arch} but the image would be built for ${building}`,
      next:
        `Set targetArch in shipkit.yaml to a runtime identifier for ${state.arch}. Deploying ` +
        "this would apply the migrations and only then fail to start the container.",
    }
  }

  if (needsDb && state.db === "stopped") {
    // Starting a stopped production database is not something to do on the side of a deploy:
    // it may have been stopped on purpose, or be stopping for a reason.
    return {
      ok: false,
      reason: "the database container exists but is not running",
      next: "Find out why it stopped and start it deliberately, then plan again.",
    }
  }

  const steps: string[] = []
  if (needsDb && state.db === "missing") {
    if (state.appContainers > 0) {
      // The app has run here before, so its database existed. A missing one now is data that
      // went somewhere, not a first deploy — booting an empty database would hide that.
      return {
        ok: false,
        reason: "the application has been deployed to this server but its database container is gone",
        next: "Do not deploy over this. Restore the database (docs/runbooks/restore.md) first.",
      }
    }
    steps.push("boot the database accessory (first deploy to this server)")
  }
  if (state.proxy !== "running") steps.push("start kamal-proxy (Kamal does this as part of the release)")
  return { ok: true, steps }
}
