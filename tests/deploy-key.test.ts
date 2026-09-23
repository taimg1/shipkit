import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyBundleCommand, copyDumpCommand } from "../.dagger/src/core/ssh-command.ts"

/**
 * The deploy key is restricted by a forced command on the server (server/bootstrap.sh restrict,
 * docs/runbooks/deploy-key.md). These tests hold the two ends of that together: what the module
 * sends, and what the dispatcher is willing to receive. Both have been broken once by a change
 * that looked entirely reasonable in isolation.
 */

const env = {
  url: "http://example.test",
  host: "server.example",
  sshPort: 22,
  sshUser: "deploy",
  network: "kamal",
  database: "app",
  dbUser: "postgres",
}

test("scp asks for the legacy protocol, or the forced command cannot see the destination", () => {
  // Do not "modernise" this away. OpenSSH 9 made scp speak SFTP by default: it opens a
  // subsystem and negotiates the destination inside it, so `SSH_ORIGINAL_COMMAND` is the
  // subsystem and not `scp -t <path>`. The deploy key's forced command allows an upload only to
  // a backup file or a migration bundle, and over SFTP there is no destination to check — so
  // the dispatcher refuses sftp outright, and dropping -O would refuse every upload a deploy
  // makes, at the backup stage, after the backup gate has already been reached.
  for (const command of [
    copyBundleCommand(env, "/bundle/efbundle", "/tmp/shipkit-efbundle.aB3xY9"),
    copyDumpCommand(env, "/backup/dump.pgc", "/var/backups/shipkit/api/.x-20260101T000000Z.pgc.partial"),
  ]) {
    assert.match(command, /^scp -O /, `scp must pass -O: ${command}`)
  }
})

test("both uploads are built the same way, so only one of them can be checked wrong", () => {
  const a = copyBundleCommand(env, "/f", "/tmp/shipkit-efbundle.aB3xY9")
  const b = copyDumpCommand(env, "/f", "/tmp/shipkit-efbundle.aB3xY9/efbundle")
  assert.equal(a, b)
})

/**
 * The dispatcher's allow-list, run against the shapes the module actually produces.
 *
 * This is the test that matters when someone edits a remote script. The allow-list lives in
 * server/bootstrap.sh as an embedded python program; it is extracted here rather than copied,
 * so there is exactly one of it.
 */
const dispatcher = (() => {
  const bootstrap = readFileSync("server/bootstrap.sh", "utf8")
  const body = /cat > "\$DISPATCH" <<'SHIPKIT_DISPATCH_EOF'\n([\s\S]*?)\nSHIPKIT_DISPATCH_EOF/.exec(bootstrap)
  assert.ok(body, "the dispatcher is no longer embedded in server/bootstrap.sh under that marker")
  const dir = mkdtempSync(join(tmpdir(), "shipkit-dispatch-"))
  const path = join(dir, "deploy-dispatch")
  writeFileSync(path, body[1])
  return path
})()

const shapes = (() => {
  const out = spawnSync("node", ["--experimental-strip-types", "tools/emit-ssh-shapes.ts"], {
    encoding: "utf8",
  })
  assert.equal(out.status, 0, `emit-ssh-shapes.ts failed: ${out.stderr}`)
  return out.stdout.trim().split("\n").map((l) => JSON.parse(l) as { name: string; kind: string; text: string })
})()

/** Asks the dispatcher's own matcher, in the process, what it makes of a script. */
function classify(script: string): string | null {
  const program = [
    "import sys, json, runpy",
    `src = open(${JSON.stringify(dispatcher)}).read().replace('if __name__ == "__main__":\\n    main()', '')`,
    "mod = type(sys)('d'); exec(compile(src, 'dispatch', 'exec'), mod.__dict__)",
    "name, why = mod.match_shipkit(sys.stdin.read())",
    "print(json.dumps(name))",
  ].join("\n")
  const out = spawnSync("python3", ["-c", program], { input: script, encoding: "utf8" })
  assert.equal(out.status, 0, `the dispatcher could not be asked: ${out.stderr}`)
  return JSON.parse(out.stdout)
}

test("every script the module sends is one the deploy key is allowed to send", () => {
  const scripts = shapes.filter((s) => s.kind === "script")
  assert.ok(scripts.length >= 16, `expected the module's remote scripts, got ${scripts.length}`)
  for (const shape of scripts) {
    assert.equal(
      classify(shape.text),
      shape.name,
      `server/bootstrap.sh does not allow ${shape.name}. A deploy against a restricted server ` +
        `would be refused here. Add the shape to SHAPES in the dispatcher — and see ` +
        `docs/runbooks/deploy-key.md before widening it.`,
    )
  }
})

test("a script that is not one of them is refused", () => {
  assert.equal(classify("cat /etc/shadow"), null)
  assert.equal(classify("docker run --rm -v /:/host alpine id"), null)
})

test("the allow-list names no service, so it covers every service on a server", () => {
  // Production runs two Kamal services as the same deploy user. A rule keyed to one of them
  // would refuse the other.
  const body = readFileSync(dispatcher, "utf8")
  for (const name of ["easytransfer-api", "easytransfer-web", "shipkit-fixture"]) {
    assert.ok(!body.includes(name), `the dispatcher is keyed to the service "${name}"`)
  }
})
