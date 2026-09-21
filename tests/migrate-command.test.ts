import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BUNDLE_DIR_TEMPLATE,
  copyBundleCommand,
  makeBundleDirScript,
  parseBundleDir,
  removeBundleDirScript,
  runBundleCommand,
} from "../.dagger/src/core/ssh-command.ts"

const env = {
  url: "http://example.test",
  host: "server.example",
  sshPort: 2222,
  sshUser: "deploy",
  network: "kamal",
  database: "app",
  dbUser: "postgres",
}

/**
 * Runs the real command with `ssh` and `docker` replaced: ssh runs the script it is sent in a
 * local sh, docker records the argv it received. What the remote shell parses is then exactly
 * what these tests look at, instead of a string that is assumed to parse the way it reads.
 */
function runMigration(dsn: string) {
  const work = mkdtempSync(join(tmpdir(), "shipkit-migrate-test-"))
  const bin = join(work, "bin")
  const dir = join(work, "stage")
  spawnSync("mkdir", ["-p", bin, dir])
  writeFileSync(join(dir, "efbundle"), "")
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexec sh\n")
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${work}/docker-argv"\n`)
  chmodSync(join(bin, "ssh"), 0o755)
  chmodSync(join(bin, "docker"), 0o755)

  const r = spawnSync("sh", ["-c", runBundleCommand(env, dir, "mcr.microsoft.com/dotnet/runtime-deps:10.0")], {
    cwd: work,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, SHIPKIT_DB_URL: dsn },
  })
  const argvFile = join(work, "docker-argv")
  const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\0").slice(0, -1) : null
  return { r, argv, work, dir, cleanup: () => rmSync(work, { recursive: true, force: true }) }
}

test("a password with quotes, $, backticks, backslashes and spaces arrives as one untouched argument", () => {
  const dsn = `Host=db;Database=app;Username=app;Password=a"b$c\`d\\e'f g $HOME $(id) \`id\` ;|&<>*?`
  const { r, argv, dir, cleanup } = runMigration(dsn)
  try {
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(argv, [
      "run", "--rm", "--network", "kamal",
      "-v", `${dir}/efbundle:/efbundle:ro`,
      "mcr.microsoft.com/dotnet/runtime-deps:10.0",
      "/efbundle", "--connection", dsn,
    ])
  } finally {
    cleanup()
  }
})

test("a password cannot run a command on the server", () => {
  const { r, work, cleanup } = runMigration("Password=$(touch pwned1)`touch pwned2`")
  try {
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(join(work, "pwned1")), false)
    assert.equal(existsSync(join(work, "pwned2")), false)
  } finally {
    cleanup()
  }
})

test("an empty connection string stops before docker runs", () => {
  const { r, argv, cleanup } = runMigration("")
  try {
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /connection string arrived empty/)
    assert.equal(argv, null)
  } finally {
    cleanup()
  }
})

test("the connection string is never part of the command text", () => {
  const command = runBundleCommand(env, "/tmp/shipkit-efbundle.abc123", "img:1")
  assert.doesNotMatch(command, /Password/)
  assert.match(command, /"\$SHIPKIT_DB_URL"/)
})

test("the bundle is staged in a directory mktemp makes, not a predictable path", () => {
  assert.match(makeBundleDirScript, /mktemp -d \/tmp\/shipkit-efbundle\.XXXXXX$/)
  assert.equal(BUNDLE_DIR_TEMPLATE.endsWith("XXXXXX"), true)
  assert.equal(parseBundleDir("/tmp/shipkit-efbundle.Ab12Cd\n"), "/tmp/shipkit-efbundle.Ab12Cd")
})

test("an answer mktemp could not have given is refused, since it is later removed with rm -rf", () => {
  for (const out of ["", "/", "/tmp", "/tmp/shipkit-efbundle.", "/tmp/shipkit-efbundle.ab/../..", "/home/deploy", "mktemp: not found"]) {
    assert.equal(parseBundleDir(out), null, out)
  }
})

test("the staging directory is removed with the path quoted and options ended", () => {
  assert.equal(removeBundleDirScript("/tmp/shipkit-efbundle.Ab12Cd"), "rm -rf -- /tmp/shipkit-efbundle.Ab12Cd")
})

test("mktemp creates a private directory", () => {
  const r = spawnSync("sh", ["-c", makeBundleDirScript.replace("/tmp/", `${tmpdir()}/`)], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  const dir = r.stdout.trim()
  try {
    const mode = spawnSync("sh", ["-c", `ls -ld '${dir}' | cut -c1-10`], { encoding: "utf8" }).stdout.trim()
    assert.equal(mode, "drwx------")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scp gets the port, the user and the private path, each as one word", () => {
  const command = copyBundleCommand(env, "/bundle/efbundle", "/tmp/shipkit-efbundle.Ab12Cd")
  assert.match(command, /-P 2222/)
  assert.match(command, /BatchMode=yes/)
  assert.match(command, / deploy@server\.example:\/tmp\/shipkit-efbundle\.Ab12Cd\/efbundle$/)
})
