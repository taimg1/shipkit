import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  STRICT_SSH_CONFIG,
  checkHostKey,
  entryMatches,
  fingerprint,
  knownHostsFor,
  knownHostsName,
  parseKnownHosts,
} from "../.dagger/src/core/known-hosts.ts"

// dev-server's committed host key, so the fixture's pin and the key the server offers are the
// same bytes the tests read.
const ED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINzSeby1W18fIv7pys7p0Pe4xiOEGK65dXpurYBTf5d1"
const EC =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBC64dD/nBEigADt9C5JhkCfQIOFL7TRbfRZW3St9bRCfThW5pZUjA5KyLVo4kax9RZfT1cnz2KPuvTuU+/zbE18="
const RSA =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7mbFgCLwjDLydOJasus2r5asnrw8XDIvWUCzp9wPgTt8jh39/+pH5vOem6U2WgIeWEClPNtiS5uEFcmPD+a/JNp2UwFWl5IoYn/MWJ5NUohrdViH9gdwI1V2J5MhgUAG/BG+NCRidT2jpT2ALrQXqnHcj/IKjoU1eHtcJ3wTSzHq4WyXKZiyoEbplT1qqJOx8nADylRgDka1xgzcWv6Fy09DuXkp67OyXtccYEkcJN73rfkp7NYb5fr4H3gkPzGjAFiM4LnSK98wX7gUylXrHvb137TwU7+3V4N9XkKf64SeKvAlGGoIqVblmhvfJ3elLEprO273wA6e9lCv6i965"

const env = (hostKey?: string, host = "203.0.113.10", sshPort = 22) => ({ host, sshPort, hostKey })

test("parses ed25519, ecdsa and rsa lines, skipping comments and blanks", () => {
  const entries = parseKnownHosts(`# pinned 2026-09-19\n\n1.2.3.4 ${ED}\n1.2.3.4 ${EC} root@box\n1.2.3.4 ${RSA}\n`)
  assert.deepEqual(entries.map((e) => e.type), ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"])
})

test("a bare key without a host field is refused", () => {
  assert.throws(() => parseKnownHosts(ED), /not a known_hosts line/)
})

test("an unsupported key type is refused", () => {
  assert.throws(() => parseKnownHosts("1.2.3.4 ssh-dss AAAAB3NzaC1kc3M="), /ssh-dss" is not one of/)
})

test("a label that disagrees with the key data is refused", () => {
  const blob = ED.split(" ")[1]
  assert.throws(() => parseKnownHosts(`1.2.3.4 ssh-rsa ${blob}`), /not a ssh-rsa key \(it is ssh-ed25519\)/)
})

test("key data that is not base64 is refused", () => {
  assert.throws(() => parseKnownHosts("1.2.3.4 ssh-ed25519 not*base64"), /not base64/)
})

test("markers are refused rather than half-understood", () => {
  assert.throws(() => parseKnownHosts(`@revoked 1.2.3.4 ${ED}`), /@revoked/)
})

test("an empty value is refused", () => {
  assert.throws(() => parseKnownHosts("# nothing\n"), /no known_hosts lines/)
})

test("ssh looks a non-default port up as [host]:port", () => {
  assert.equal(knownHostsName("h", 22), "h")
  assert.equal(knownHostsName("h", 2222), "[h]:2222")
})

test("a plain entry matches its host on port 22 and not on another port", () => {
  const [e] = parseKnownHosts(`203.0.113.10 ${ED}`)
  assert.ok(entryMatches(e, "203.0.113.10", 22))
  assert.ok(!entryMatches(e, "203.0.113.10", 2222))
  assert.ok(!entryMatches(e, "203.0.113.11", 22))
})

test("comma lists, patterns and negations follow OpenSSH", () => {
  const [e] = parseKnownHosts(`api.client.com,203.0.113.10 ${ED}`)
  assert.ok(entryMatches(e, "203.0.113.10", 22))
  const [w] = parseKnownHosts(`*.client.com,!db.client.com ${ED}`)
  assert.ok(entryMatches(w, "api.client.com", 22))
  assert.ok(!entryMatches(w, "db.client.com", 22))
})

test("a hashed entry (ssh-keygen -H) matches the name it hashes", () => {
  const [e] = parseKnownHosts(`|1|fLa6pn7ZIZ1xSDui8iacTG520lg=|8o75rFygJgFDSVLGcjn0NcfYH6E= ${ED}`)
  assert.ok(entryMatches(e, "host.docker.internal", 2222))
  assert.ok(!entryMatches(e, "host.docker.internal", 22))
})

test("fingerprints match ssh-keygen -lf", () => {
  const [e] = parseKnownHosts(`h ${ED}`)
  assert.equal(fingerprint(e), "SHA256:5kCc5wjjO3Qqwji4vrIROmWSCPd2q9YgX0BqWukHrp4")
})

test("the known_hosts file is refused when no line names the host and port", () => {
  assert.throws(() => knownHostsFor(env(`203.0.113.10 ${ED}`, "203.0.113.10", 2222)), /no line for \[203\.0\.113\.10\]:2222/)
  assert.throws(() => knownHostsFor(env(undefined)), /no hostKey/)
})

test("the known_hosts file carries every pinned line, normalised", () => {
  const text = knownHostsFor(env(`203.0.113.10 ${ED} a comment\n203.0.113.10 ${EC}`))
  assert.equal(text, `203.0.113.10 ${ED}\n203.0.113.10 ${EC}\n`)
})

test("doctor reports the fingerprint, or MISMATCH when the pin is for another host", () => {
  assert.match(checkHostKey("prod", env(`203.0.113.10 ${ED}`)), /^ok \(prod: ssh-ed25519 SHA256:5kCc/)
  assert.match(checkHostKey("prod", env(`198.51.100.1 ${ED}`)), /^MISMATCH/)
})

test("the Kamal ssh config turns strict checking on and trusts only the pinned file", () => {
  assert.match(STRICT_SSH_CONFIG, /^StrictHostKeyChecking yes$/m)
  assert.match(STRICT_SSH_CONFIG, /^UserKnownHostsFile \/root\/\.ssh\/known_hosts$/m)
  assert.doesNotMatch(STRICT_SSH_CONFIG, /accept-new|StrictHostKeyChecking no/)
})

test("the fixture pins dev-server's committed host key", () => {
  const pub = readFileSync(new URL("../dev-server/host-key/ssh_host_ed25519_key.pub", import.meta.url), "utf8")
  const yaml = readFileSync(new URL("../fixtures/dotnet-api/shipkit.yaml", import.meta.url), "utf8")
  const hostKey = /^\s+hostKey:\s*"(.*)"\s*$/m.exec(yaml)?.[1]
  assert.ok(hostKey, "fixtures/dotnet-api/shipkit.yaml has no hostKey")
  assert.equal(pub.split(" ").slice(0, 2).join(" "), ED)
  assert.equal(knownHostsFor({ host: "host.docker.internal", sshPort: 2222, hostKey }), `[host.docker.internal]:2222 ${ED}\n`)
})
