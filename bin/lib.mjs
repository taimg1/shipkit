/**
 * Pure helpers for the shipkit wrapper.
 *
 * Separated so they can be tested without spawning git, Dagger or Docker. The wrapper's bugs
 * so far — a git SHA passed where a migration id belongs, flags parsed and then dropped — all
 * lived in exactly this kind of code, and a test would have caught each before a pipeline run.
 */

/**
 * The newest migration id in a `git ls-tree -r --name-only` listing.
 *
 * Migration ids are a 14-digit timestamp followed by a name, a convention EF, Prisma and
 * Drizzle all share, so this is not stack knowledge. Ids sort chronologically because they
 * start with that timestamp.
 *
 * Returns undefined when the tree holds no migrations, which the module reads as
 * "lint everything" — the safe direction.
 */
export function newestMigrationId(treeOutput) {
  const ids = treeOutput
    .split("\n")
    .map((path) => path.split("/").pop() ?? "")
    .map((name) => /^(\d{14}_[^.]+)\./.exec(name)?.[1])
    .filter((id) => id !== undefined)

  return ids.sort().pop()
}

/**
 * The `kit:` pin from shipkit.yaml.
 *
 * Read with a line-anchored regex rather than a YAML parser: it is a single top-level
 * scalar, the wrapper stays dependency-free, and the module validates the file properly on
 * the other side. Anything indented belongs to another key and must not match.
 */
export function parseKitRef(yamlText) {
  return /^kit:[ \t]*(\S+)[ \t]*$/m.exec(yamlText)?.[1]
}

/**
 * `defaultBranch` from shipkit.yaml — the branch production is built from, and so the branch
 * the migration diff base is taken against. Same line-anchored reading as `kit:`; the module
 * applies the same default.
 */
export function parseDefaultBranch(yamlText) {
  const m = /^defaultBranch:[ \t]*(["']?)([^\s"'#]+)\1[ \t]*(#.*)?$/m.exec(yamlText)
  return m?.[2] ?? "main"
}

export const EXIT = { OK: 0, GATE: 1, CONFIG: 2, INFRA: 3, CONFIRM: 4, NOT_IMPLEMENTED: 5 }

/**
 * Every option the wrapper accepts, per command.
 *
 * An option a command does not use is rejected, not ignored. `shipkit ci --migration-base=X`
 * once returned a cached report that had never seen X — the flag was parsed, dropped, and the
 * run looked like an answer to a question nobody had asked it (#2).
 *
 * "flag" never takes the next argument as its value; "value" does. Without that distinction
 * `shipkit --json ci` read "ci" as the value of --json.
 */
const GLOBAL_OPTIONS = { json: "flag", sha: "value", explain: "flag", module: "value", report: "value" }

export const COMMAND_OPTIONS = {
  ci: { stage: "value", branch: "value", "migration-base": "value" },
  "db lint": { "migration-base": "value" },
  "db pending": { "migration-base": "value" },
  deploy: { env: "value", plan: "flag", yes: "value", stage: "value", "ssh-key": "value" },
  backup: { env: "value", out: "value", "ssh-key": "value" },
  rollback: { env: "value", "ssh-key": "value" },
  doctor: {},
  // Reads report files and prints markdown. It calls no module, so it takes no module options.
  summary: { title: "value", jobs: "value" },
}

function optionKind(name) {
  if (GLOBAL_OPTIONS[name]) return GLOBAL_OPTIONS[name]
  for (const opts of Object.values(COMMAND_OPTIONS)) if (opts[name]) return opts[name]
  return undefined
}

/**
 * Splits argv into options, positionals and — after `--raw` — arguments for Dagger.
 *
 * Options before `--raw` are kept, so `shipkit --module <ref> --raw ci ...` still knows which
 * module to call (#3). Everything after it is Dagger's and is not interpreted.
 */
export function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--raw") {
      opts.raw = argv.slice(i + 1)
      return opts
    }
    if (!a.startsWith("--")) {
      opts._.push(a)
      continue
    }
    const eq = a.indexOf("=")
    const name = eq > -1 ? a.slice(2, eq) : a.slice(2)
    if (eq > -1) opts[name] = a.slice(eq + 1)
    else if (optionKind(name) === "value" && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      opts[name] = argv[++i]
    } else opts[name] = true
  }
  return opts
}

/** `db lint` and `db pending` are two words; every other command is one. */
export function commandKey(positionals) {
  const [cmd, sub] = positionals
  return cmd === "db" && sub ? `db ${sub}` : cmd
}

/**
 * Rejects options the command does not take, and options given without the value they need.
 * Returns undefined when everything is accepted, otherwise `{ code, message }`.
 */
export function validateOptions(key, opts) {
  const allowed = { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[key] ?? {}) }
  for (const [name, value] of Object.entries(opts)) {
    if (name === "_" || name === "raw") continue
    const kind = allowed[name]
    if (!kind) {
      const own = Object.keys(COMMAND_OPTIONS[key] ?? {}).map((o) => `--${o}`)
      return {
        code: EXIT.CONFIG,
        message:
          `unknown option --${name} for "shipkit ${key}"` +
          (own.length ? ` (it takes: ${own.join(", ")})` : ` (it takes no command options)`),
      }
    }
    if (kind === "value" && value === true) {
      // A bare --yes is a deploy without a token: that is the confirmation contract, not a typo.
      if (key === "deploy" && name === "yes") {
        return { code: EXIT.CONFIRM, message: "--yes needs the plan token printed by `shipkit deploy --plan`" }
      }
      return { code: EXIT.CONFIG, message: `--${name} needs a value` }
    }
    if (kind === "flag" && value !== true) {
      return { code: EXIT.CONFIG, message: `--${name} takes no value` }
    }
  }
  return undefined
}

/**
 * Which module to call, or why there is none.
 *
 * Order: --module, SHIPKIT_MODULE, the `kit:` line. With none of those, the only module Dagger
 * could find is a local one — which is right inside the shipkit repository (its own fixture
 * runs that way) and wrong everywhere else. Without this check a client project got
 * `unknown command "doctor" for "dagger call"` and exit 3, which reads as broken
 * infrastructure rather than a missing line of configuration (#7).
 *
 * `localModule` is the `name` from the nearest dagger.json above the working directory.
 */
export function resolveModule({ option, envVar, yamlText, localModule }) {
  const ref = option || envVar || (yamlText ? parseKitRef(yamlText) : undefined)
  if (ref) return { ref }
  if (localModule === "shipkit") return { ref: undefined }
  return {
    error:
      "no shipkit module to call: add `kit: github.com/taimg1/shipkit@<commit>` to shipkit.yaml, " +
      "set SHIPKIT_MODULE, or pass --module <ref>",
  }
}

/** Whether raw Dagger arguments already name a module with -m / --mod. */
export function namesModule(raw) {
  return raw.some((a) => a === "-m" || a === "--mod" || a.startsWith("-m=") || a.startsWith("--mod="))
}

/** `dagger call` arguments for --raw: the module goes first unless the caller named one. */
export function rawCallArgs(raw, ref) {
  return ref && !namesModule(raw) ? ["call", "-m", ref, ...raw] : ["call", ...raw]
}

/**
 * Whether `git status --porcelain` shows changes that would end up in the build.
 *
 * `--source=.` is the working tree, but the image is tagged with HEAD's SHA. With uncommitted
 * changes those are different things, and the tag would claim a commit the image is not (#6).
 * `.shipkit/` is this tool's own run log and never part of the source.
 */
export function isDirty(porcelain) {
  return porcelain
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .some((path) => !/(^|\/)\.shipkit(\/|$)/.test(path.split(" -> ").pop()))
}

/**
 * Kamal reads `.kamal/secrets`, a file of `NAME=value` lines where a value may be `$VAR`, taken
 * from the environment Kamal runs in. The kit runs Kamal inside a container that has none of
 * those variables, so every reference resolved to an empty string and the deploy carried on
 * with it (#19).
 *
 * This expands the references here, where the environment actually is, so the container receives
 * values rather than names. The file itself stays as the project wrote it: references, no values,
 * safe to commit — though it is gitignored anyway, and should stay that way.
 *
 * A reference with nothing behind it is refused rather than expanded to nothing. That is the
 * whole point: an empty secret is how a deploy gets to production and misbehaves there.
 */
export function expandSecretsFile(text, env) {
  const missing = []
  const unquotable = []
  const lines = []

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "")
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (line.trim().length === 0 || line.trimStart().startsWith("#") || !pair) {
      lines.push(line)
      continue
    }

    const [, name, value] = pair
    const reference = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim())
    // A literal value is the project's business; only references are ours to resolve.
    if (!reference) {
      lines.push(line)
      continue
    }

    // The kit injects this one into Kamal's container itself, as a Dagger secret. Resolving it
    // here would copy the registry token into a file for no reason.
    if (reference[1] === "KAMAL_REGISTRY_PASSWORD") {
      lines.push(line)
      continue
    }

    const resolved = env[reference[1]]
    if (resolved === undefined || resolved === "") {
      missing.push(reference[1])
      continue
    }
    // Written single-quoted. Kamal parses this file with dotenv plus its inline command
    // substitution, so an unquoted `$x` in a value is expanded and `$(...)` is RUN — a password
    // with a `$` in it silently became another password, and one with `$(...)` a command.
    // Inside single quotes dotenv takes everything literally, with no escape for a quote or a
    // line break: a value holding either is refused rather than written in a form Kamal reads
    // differently. Found on dev-server.
    if (/['\r\n]/.test(resolved)) {
      unquotable.push(reference[1])
      continue
    }
    lines.push(`${name}='${resolved}'`)
  }

  if (missing.length > 0) return { missing }
  if (unquotable.length > 0) return { unquotable }
  return { content: lines.join("\n").replace(/\n+$/, "") + "\n" }
}

/**
 * The branch `ci` names to the module, which publishes only when it is the default branch.
 *
 * On GitHub Actions the answer comes from the event, never from a branch name. A pull request's
 * head branch is chosen by whoever opened it: a fork whose branch is called `main` used to be
 * reported as `main` and pass the publish check. Only a push names a branch that was actually
 * pushed to; everything else — pull_request, workflow_dispatch, schedule — is reported as the
 * event and ref it is, which is never equal to a branch name and so never publishes. An
 * explicit --branch does not change that: on a pull request it is as much the author's as
 * GITHUB_HEAD_REF.
 *
 * Outside GitHub Actions: --branch, else the checked-out branch from git (`local`), else
 * undefined — which the module refuses to publish from rather than guessing.
 */
export function publishBranch(env, explicit, local) {
  if (env.GITHUB_ACTIONS === "true") {
    const ref = env.GITHUB_REF ?? ""
    if (env.GITHUB_EVENT_NAME !== "push" || !ref.startsWith("refs/heads/")) {
      return `${env.GITHUB_EVENT_NAME || "unknown-event"}:${ref || "unknown-ref"}`
    }
    return explicit || ref.slice("refs/heads/".length)
  }
  return explicit || local()
}

const REGISTRY_TOKEN_VAR = "SHIPKIT_REGISTRY_TOKEN"
const SSH_KEY_VAR = "SHIPKIT_SSH_KEY"
const DB_URL_VAR = "SHIPKIT_DATABASE_URL"
const KAMAL_SECRETS_VAR = "SHIPKIT_KAMAL_SECRETS"

/**
 * Credentials, passed by reference.
 *
 * `file:` and `env:` are Dagger's own syntax for reading a secret on the engine side. The
 * values never become command-line arguments, so they cannot appear in a process listing, a
 * shell history, or this tool's run log.
 */
function credentials(opts, env, { dbUrl = false } = {}) {
  const args = []
  const keyPath = opts["ssh-key"] || env[SSH_KEY_VAR]
  if (keyPath) args.push(`--ssh-key=file:${keyPath}`)
  // Only the stages that apply migrations take a connection string. Passing it to a function
  // that has no such parameter is an error, not a harmless extra.
  if (dbUrl && env[DB_URL_VAR]) args.push(`--db-url=env:${DB_URL_VAR}`)
  if (env[REGISTRY_TOKEN_VAR]) args.push(`--registry-token=env:${REGISTRY_TOKEN_VAR}`)
  // Set by the wrapper from the project's .kamal/secrets, with its references resolved (#19).
  if (env[KAMAL_SECRETS_VAR]) args.push(`--kamal-secrets=env:${KAMAL_SECRETS_VAR}`)
  return args
}

/**
 * Translates a shipkit command into `dagger call` arguments.
 *
 * Pure: everything that needs git or the environment comes in through `ctx`, as functions, so
 * a command that does not need the migration base never runs `git ls-tree` for it.
 *
 * Returns undefined for an unknown command and null for a deploy without a plan or token.
 */
export function translate(key, opts, ctx) {
  const src = ["--source=."]
  const sha = () => opts.sha || ctx.sha()
  // An explicit --migration-base wins over the one derived from git (#2).
  const base = () => opts["migration-base"] || ctx.migrationBase()
  const withBase = (a) => {
    const b = base()
    return b ? [...a, `--migration-base=${b}`] : a
  }

  switch (key) {
    case "ci": {
      const a = withBase(["ci", ...src, `--sha=${sha()}`, ...(opts.stage ? [`--stage=${opts.stage}`] : [])])

      const branch = publishBranch(ctx.env, opts.branch, ctx.branch)
      if (branch) a.push(`--branch=${branch}`)
      if (ctx.dirty()) a.push("--dirty")

      if (ctx.env[REGISTRY_TOKEN_VAR]) {
        a.push(`--registry-token=env:${REGISTRY_TOKEN_VAR}`)
        if (ctx.env.GITHUB_ACTOR) a.push(`--registry-user=${ctx.env.GITHUB_ACTOR}`)
      }
      return a
    }
    // Both diff against the same base as ci. Without it "not on main" meant "every migration".
    case "db lint":
      return withBase(["db-lint", ...src])
    case "db pending":
      return withBase(["db-pending", ...src])
    case "deploy": {
      const target = [...src, `--env=${opts.env || "prod"}`, `--sha=${sha()}`]
      // The plan token names the stages (B7), so the plan is built for the same --stage the
      // deploy will be given.
      const stage = opts.stage ? [`--stage=${opts.stage}`] : []
      if (opts.plan) return ["deploy-plan", ...target, ...credentials(opts, ctx.env), ...stage]
      if (typeof opts.yes === "string") {
        // Recorded in the server-side deploy lock, so a refused deploy can say who holds it.
        const actor = ctx.env.GITHUB_ACTOR || ctx.env.USER || ctx.env.USERNAME
        return [
          "deploy",
          ...target,
          ...credentials(opts, ctx.env, { dbUrl: true }),
          `--plan-token=${opts.yes}`,
          ...stage,
          ...(actor ? [`--actor=${actor}`] : []),
        ]
      }
      return null
    }
    // #11: this case existed and called a module function that did not. The command was
    // documented, printed in usage, and did nothing but fail obscurely.
    //
    // The target is named, never inferred: "the previous one" is exactly what an operator is
    // least sure of mid-incident, and rolling back to a guess is another unconfirmed deploy.
    case "rollback": {
      const to = opts._?.[1]
      if (!to) return null
      return [
        "rollback",
        ...src,
        `--to-version=${to}`,
        `--env=${opts.env || "prod"}`,
        ...credentials(opts, ctx.env),
      ]
    }
    // The module returns a directory — report.json always, dump.pgc when verified — exported
    // next to --out, so the dump can be renamed into place without crossing a filesystem.
    case "backup": {
      return [
        "backup",
        ...src,
        `--env=${opts.env || "prod"}`,
        `--sha=${sha()}`,
        ...credentials(opts, ctx.env),
        "export",
        `--path=${backupExportDir(backupOut(opts))}`,
      ]
    }
    case "doctor":
      return ["doctor", ...src]
    default:
      return undefined
  }
}

/** Where `shipkit backup` writes the dump. */
export const backupOut = (opts) => opts.out || "prod-backup.pgc"

/** The directory the module's result is exported into: hidden, beside the dump it becomes. */
export function backupExportDir(out) {
  const slash = out.lastIndexOf("/")
  const dir = slash >= 0 ? out.slice(0, slash + 1) : ""
  return `${dir}.${out.slice(slash + 1)}.shipkit-export`
}

/**
 * Takes the exported backup directory apart: the report, and the dump when the report says it
 * is good. Returns { report } or { error } — never a report from a directory that has none, and
 * never a dump the report did not vouch for.
 *
 * `fs` is injected so this can be tested without writing a production dump anywhere. The dump is
 * made owner-only before it gets its final name and never exists there with other permissions.
 */
export function collectBackup(dir, out, fs) {
  let report
  try {
    report = JSON.parse(fs.readFileSync(`${dir}/report.json`, "utf8"))
  } catch {
    return { error: "the backup produced no readable report" }
  }
  if (!report.ok) return { report }

  const dump = `${dir}/dump.pgc`
  if (!fs.existsSync(dump)) {
    return { error: "the backup reported success but returned no dump" }
  }
  fs.chmodSync(dump, 0o600)
  fs.renameSync(dump, out)
  return { report: { ...report, written: out } }
}
