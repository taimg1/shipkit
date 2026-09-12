/**
 * Pure helpers for the shipkit wrapper.
 *
 * Separated so they can be tested without spawning git, Dagger or Docker. The wrapper's
 * one real bug so far — passing a git SHA where a migration id belongs — lived in exactly
 * this kind of code, and a test would have caught it before a pipeline run did.
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
