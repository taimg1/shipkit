/**
 * `buildArgs:` from shipkit.yaml — pure, so the rule that decides what reaches a build can be
 * tested without Dagger.
 *
 * Next inlines NEXT_PUBLIC_* into the browser bundle during `build`, so a site needs its
 * public configuration at build time. It belongs in shipkit.yaml rather than in workflow YAML
 * because the image tag is the commit: two builds of one commit must produce one image, and a
 * value that varies per run would quietly break that.
 *
 * Public by construction. A build argument ends up in the image, and for Next in the bundle
 * every visitor downloads; secrets do not go here (ADR 0006).
 */

export type BuildArgs =
  | { ok: true; args: Record<string, string> }
  | { ok: false; message: string; next: string }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseBuildArgs(raw: unknown): BuildArgs {
  if (raw === undefined || raw === null) return { ok: true, args: {} }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      message: "buildArgs must be a mapping of NAME: value",
      next: "For example:\n  buildArgs:\n    NEXT_PUBLIC_SITE_URL: https://example.com",
    }
  }

  const args: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME.test(name)) {
      return {
        ok: false,
        message: `buildArgs.${name} is not a usable build argument name`,
        next: "Letters, digits and underscores, not starting with a digit.",
      }
    }
    // The kit passes it, from the commit being built. A project value would overwrite the one
    // thing `verify` compares the running container against.
    if (name === "GIT_SHA") {
      return {
        ok: false,
        message: "buildArgs must not set GIT_SHA",
        next: "The kit passes the commit being built; /health reports it and verify checks it.",
      }
    }
    // A number or a boolean is written out rather than refused: `3` and `true` are ordinary
    // values for a build argument. A mapping has no sensible text, and guessing one would put
    // something arbitrary in the bundle.
    if (value === null || value === undefined || typeof value === "object") {
      return {
        ok: false,
        message: `buildArgs.${name} must be a value, not ${value === null || value === undefined ? "empty" : "a mapping"}`,
        next: "Build arguments are strings; write the value out.",
      }
    }
    args[name] = String(value)
  }
  return { ok: true, args }
}
