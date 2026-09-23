#!/usr/bin/env bash
#
# Prepares a bare Ubuntu server for shipkit deploys, without ever locking you out of it.
#
# The pipeline deploys to a prepared server and refuses to install system packages on one
# (core/server-probe.ts). This is what prepares it.
#
# Two phases, because the dangerous part of hardening a server is the part that closes the
# door you are standing in:
#
#   prepare   everything that cannot lock anyone out — deploy user, its key, Docker,
#             firewall, swap, automatic security updates. Root and passwords still work.
#   harden    closes the password door. Refuses to run until it can see that the deploy
#             user has actually logged in with its key. A hardening step that trusts you
#             remembered to test the key is not a gate.
#   restrict  puts the deploy key behind a forced command, so the private half sitting in a
#             CI secret store buys a deploy rather than a shell. Refuses to leave the
#             restriction in place unless its own self-test passes.
#
# `unrestrict` undoes the third in one command, from root, for the night it is in the way.
#
# Usage, from a workstation:
#
#   scp ~/.ssh/shipkit_deploy.pub root@HOST:/tmp/deploy.pub
#   ssh root@HOST 'bash -s' -- prepare --key-file /tmp/deploy.pub < server/bootstrap.sh
#   ssh -i ~/.ssh/shipkit_deploy deploy@HOST 'docker info >/dev/null && echo ok'
#   ssh root@HOST 'bash -s' -- harden < server/bootstrap.sh
#   ssh root@HOST 'bash -s' -- restrict < server/bootstrap.sh
#
# Every phase is idempotent: running it twice changes nothing the second time.

set -euo pipefail

# The kit's exit codes (docs/cli-design.md): 1 a gate said no, 2 configuration, 3 infrastructure.
EXIT_GATE=1
EXIT_CONFIG=2
EXIT_INFRA=3

USER_NAME=deploy
SSH_PORT=22
# Where `restrict` puts its three pieces. All root-owned, all outside the deploy user's home:
# a restriction the restricted account can edit is a suggestion.
DISPATCH=/usr/local/lib/shipkit/deploy-dispatch
POLICY=/etc/shipkit/deploy-key.policy
KEYS_DIR=/etc/ssh/authorized_keys.d
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-shipkit-deploy-key.conf
SWAP_SIZE=2G
PUBKEY=""
PUBKEY_FILE=""

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
die()  { local code=$1; shift; printf '\nERROR: %s\n' "$*" >&2; exit "$code"; }

usage() {
  cat >&2 <<'USAGE'
usage: bootstrap.sh prepare    --key-file <path on the server> | --key "<ssh public key>"
                               [--user deploy] [--ssh-port 22] [--swap 2G]
       bootstrap.sh harden     [--user deploy] [--ssh-port 22]
       bootstrap.sh restrict   [--user deploy]
       bootstrap.sh unrestrict [--user deploy]
       bootstrap.sh check      [--user deploy]
USAGE
  exit 2
}

[ "$#" -ge 1 ] || usage
PHASE=$1; shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --key)      PUBKEY=${2-}; shift 2 ;;
    --key-file) PUBKEY_FILE=${2-}; shift 2 ;;
    --user)     USER_NAME=${2-}; shift 2 ;;
    --ssh-port) SSH_PORT=${2-}; shift 2 ;;
    --swap)     SWAP_SIZE=${2-}; shift 2 ;;
    -h|--help)  usage ;;
    *)          printf 'unknown option: %s\n' "$1" >&2; usage ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die $EXIT_CONFIG "run this as root on the server."
[ -r /etc/os-release ] || die $EXIT_CONFIG "cannot read /etc/os-release; this script targets Ubuntu."
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die $EXIT_CONFIG "this script targets Ubuntu; found ${PRETTY_NAME:-unknown}."

# --------------------------------------------------------------------------------------------
# Shared checks
# --------------------------------------------------------------------------------------------

# Whether sshd has ever accepted a public key for this user. Both sources are checked because
# a journal can be vacuumed and auth.log can be rotated; either one seeing it is proof enough.
key_login_seen() {
  local u=$1 journal
  # Read into a variable first. `grep -q` exits at the first match and SIGPIPEs journalctl;
  # `set -o pipefail` then makes the pipeline status 141, the `&&` does not fire, and this gate
  # reports "never" for a server that has logged that user in a hundred times.
  journal=$(journalctl -u ssh -u sshd --no-pager -q 2>/dev/null || true)
  grep -q "Accepted publickey for ${u} " <<<"$journal" && return 0
  grep -qs "Accepted publickey for ${u} " /var/log/auth.log /var/log/auth.log.1 && return 0
  return 1
}

# sshd's effective configuration, read once into a variable so that nothing downstream has to
# read it through a pipe. `sshd -T` writes ~94 lines; a reader that stops early kills it with
# SIGPIPE, and under `set -o pipefail` that becomes the exit status of the whole pipeline.
sshd_effective() {
  local u=${1:-}
  if [ -n "$u" ]; then
    sshd -T -C "user=${u},host=localhost,addr=127.0.0.1" </dev/null 2>/dev/null || true
  else
    sshd -T </dev/null 2>/dev/null || true
  fi
}

# Same pipefail trap as sshd_effective: `head -1` closes the pipe under ufw, and the fallback
# then reports an active firewall as "not installed".
firewall_state() {
  local status
  status=$(ufw status 2>/dev/null || true)
  [ -n "$status" ] || { echo "not installed"; return; }
  sed -n '1s/^Status: //p' <<<"$status"
}

report_state() {
  local u=$1
  local SSHD_EFFECTIVE
  SSHD_EFFECTIVE=$(sshd_effective)
  printf '\nserver state\n'
  printf '  %-22s %s\n' "host" "$(hostname)"
  printf '  %-22s %s\n' "os" "${PRETTY_NAME:-unknown}"
  if id "$u" >/dev/null 2>&1; then
    printf '  %-22s %s\n' "user ${u}" "exists, groups: $(id -nG "$u" | tr ' ' ',')"
  else
    printf '  %-22s %s\n' "user ${u}" "MISSING"
  fi
  printf '  %-22s %s\n' "docker" "$(command -v docker >/dev/null && docker --version || echo MISSING)"
  if id "$u" >/dev/null 2>&1 && command -v docker >/dev/null; then
    if runuser -u "$u" -- docker info >/dev/null 2>&1; then
      printf '  %-22s %s\n' "docker as ${u}" "ok"
    else
      printf '  %-22s %s\n' "docker as ${u}" "UNAVAILABLE (the deploy would refuse)"
    fi
  fi
  printf '  %-22s %s\n' "swap" "$(swapon --show=SIZE --noheadings 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true)"
  printf '  %-22s %s\n' "firewall" "$(firewall_state)"
  printf '  %-22s %s\n' "root login" "$(awk '/^permitrootlogin/{print $2}' <<<"$SSHD_EFFECTIVE")"
  printf '  %-22s %s\n' "password auth" "$(awk '/^passwordauthentication/{print $2}' <<<"$SSHD_EFFECTIVE")"
  if key_login_seen "$u"; then
    printf '  %-22s %s\n' "key login by ${u}" "seen"
  else
    printf '  %-22s %s\n' "key login by ${u}" "never (harden will refuse)"
  fi
  # Matched against a here-string, never a pipe. `grep -q` stops at the first hit and closes the
  # pipe under it; with `set -o pipefail` that makes the whole pipeline exit 141 (SIGPIPE) about
  # four runs in five, and this `if` then took the else branch and reported a restricted server
  # as UNRESTRICTED — the one direction of that answer nobody should ever be given by accident.
  if [ -f "$SSHD_DROPIN" ] && grep -q "^forcecommand ${DISPATCH}$" <<<"$(sshd_effective "$u")"; then
    printf '  %-22s %s\n' "deploy key" "restricted to a forced command ($(policy_line))"
  else
    printf '  %-22s %s\n' "deploy key" "UNRESTRICTED (a shell, and ${u} is in the docker group)"
  fi
  report_host_key
}

# The server's ed25519 host key: the line to pin in shipkit.yaml as hostKey, and the
# fingerprint to check it against. Printed here, on the server, because this is the one place
# it cannot have been substituted in transit — `ssh-keyscan` from a workstation is answered by
# whoever sits in the middle, so its output is trusted only once it matches this.
report_host_key() {
  local pub=/etc/ssh/ssh_host_ed25519_key.pub ip port name
  ip=$(hostname -I | awk '{print $1}')
  # `check` reports the server as it is; prepare and harden report the port harden sets.
  port=$SSH_PORT
  if [ "$PHASE" = check ]; then
    # Here-string, not a pipe: `awk ... exit` stops reading and SIGPIPEs sshd, which under
    # pipefail ended the script (exit 141) before it printed the host key. Pre-dates the
    # forced command; it only ever showed up in `check`.
    port=$(awk '$1 == "port" {print $2; exit}' <<<"$(sshd_effective)")
    port=${port:-$SSH_PORT}
  fi
  if [ "$port" = 22 ]; then name=$ip; else name="[${ip}]:${port}"; fi

  printf '\nhost key (pin as hostKey in shipkit.yaml; docs/runbooks/server-bootstrap.md)\n'
  if [ -r "$pub" ]; then
    printf '  %-22s %s\n' "fingerprint" "$(ssh-keygen -lf "$pub" | awk '{print $2}')"
    printf '  %-22s %s %s\n' "known_hosts line" "$name" "$(cut -d' ' -f1,2 "$pub")"
    printf '  %-22s %s\n' "" "(replace ${ip} with the name shipkit.yaml uses as host, if different)"
  else
    printf '  %-22s %s\n' "ed25519 host key" "MISSING (sshd has none; the pipeline accepts ed25519, ecdsa or rsa)"
  fi
}

# --------------------------------------------------------------------------------------------
# prepare
# --------------------------------------------------------------------------------------------

prepare() {
  # --key-file is the one that always works. Everything after `bash -s --` is joined by ssh into
  # a single string and parsed by a shell ON THE SERVER, so local quoting is already gone by
  # then: a key whose comment contains spaces or parentheses — which `ssh-keygen -C "shipkit
  # deploy (test vps-1)"` produces — dies as a remote syntax error before this script runs at
  # all. A path has nothing in it for a shell to misread.
  if [ -n "$PUBKEY_FILE" ]; then
    [ -r "$PUBKEY_FILE" ] || die $EXIT_CONFIG "--key-file ${PUBKEY_FILE} cannot be read. It is a path ON THE SERVER; copy the .pub there first."
    local keys
    keys=$(grep -cE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)' "$PUBKEY_FILE" || true)
    # One key, or say so. Taking the first line of a file holding two would authorise one of
    # them and leave the other looking installed — and the pipeline has exactly one key.
    [ "$keys" = 1 ] || die $EXIT_CONFIG "$(printf '%s holds %s public keys; prepare authorises one.\nPass a file with a single key, or name it with --key.' "$PUBKEY_FILE" "$keys")"
    PUBKEY=$(grep -m1 -E '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)' "$PUBKEY_FILE")
  fi
  [ -n "$PUBKEY" ] || die $EXIT_CONFIG "--key-file (or --key) is required: the public half of the key the pipeline will deploy with."
  case "$PUBKEY" in
    ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *|sk-ssh-*\ *) ;;
    *) die $EXIT_CONFIG "--key does not look like an SSH public key. Pass the .pub file's contents, not a path." ;;
  esac

  export DEBIAN_FRONTEND=noninteractive

  step "1/7  packages"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades python3 >/dev/null
  say "base packages present"

  step "2/7  deploy user"
  if id "$USER_NAME" >/dev/null 2>&1; then
    say "user ${USER_NAME} already exists"
  else
    # No password is set, so the key is the only way in. --disabled-password leaves "*" in
    # /etc/shadow, which sshd accepts for key logins; a locked "!" account it would not.
    adduser --disabled-password --gecos "" "$USER_NAME" >/dev/null
    say "created ${USER_NAME} with no password"
  fi

  local ssh_dir="/home/${USER_NAME}/.ssh"
  install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$ssh_dir"
  touch "$ssh_dir/authorized_keys"
  if grep -qxF "$PUBKEY" "$ssh_dir/authorized_keys"; then
    say "key already authorised"
  else
    printf '%s\n' "$PUBKEY" >> "$ssh_dir/authorized_keys"
    say "key added"
  fi
  chown "$USER_NAME:$USER_NAME" "$ssh_dir/authorized_keys"
  chmod 600 "$ssh_dir/authorized_keys"

  # Every deploy stores its verified pre-deploy dump here before migrating, and fails closed if
  # it cannot (docs/runbooks/restore.md). Production data: the deploy user's and nobody else's.
  install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" /var/backups/shipkit
  say "/var/backups/shipkit ready for ${USER_NAME} (mode 700)"

  step "3/7  docker"
  if command -v docker >/dev/null 2>&1; then
    say "already installed: $(docker --version)"
  else
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$(dpkg --print-architecture)" "${VERSION_CODENAME}" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null \
      || die $EXIT_INFRA "installing Docker failed."
    say "installed: $(docker --version)"
  fi

  # Unbounded json-file logs are the classic way a small VPS runs out of disk while everything
  # looks healthy. Only written if the operator has no daemon.json of their own.
  if [ ! -e /etc/docker/daemon.json ]; then
    install -d -m 0755 /etc/docker
    cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
    systemctl restart docker
    say "log rotation set (10m x 3)"
  else
    say "daemon.json exists; left alone"
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true

  # Kamal requires this, and it is root-equivalent: anyone who can run a container can mount
  # the host's filesystem. Said plainly rather than pretended away (docs/runbooks/deploy.md).
  if grep -qx docker <<<"$(id -nG "$USER_NAME" | tr ' ' '\n')"; then
    say "${USER_NAME} already in the docker group"
  else
    usermod -aG docker "$USER_NAME"
    say "${USER_NAME} added to the docker group (root-equivalent, and what Kamal needs)"
  fi

  step "4/7  firewall"
  # Allows before enable: the other order drops the session this is running in.
  ufw allow "${SSH_PORT}/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  say "deny incoming except ${SSH_PORT}, 80, 443"
  # A container published with -p bypasses ufw by writing its own iptables rules. The kit's
  # accessories publish nothing, but anything added by hand can quietly open a port.
  say "note: docker -p publishes past ufw; keep accessories unpublished"

  step "5/7  swap"
  if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
    say "already active: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
  else
    fallocate -l "$SWAP_SIZE" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
    say "created ${SWAP_SIZE} at /swapfile"
  fi

  step "6/7  automatic security updates"
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
  say "security updates applied daily"

  step "7/7  clock"
  timedatectl set-timezone UTC
  timedatectl set-ntp true >/dev/null 2>&1 || true
  say "UTC, synchronised"

  report_state "$USER_NAME"

  if [ "$(awk '/^passwordauthentication/{print $2}' <<<"$(sshd_effective)")" = yes ]; then
    printf '\nprepare is done. Root and password login are still on, deliberately.\n'
  else
    printf '\nprepare is done. This server was already hardened; nothing was reopened.\n'
  fi

  cat <<NEXT

Verify the key works BEFORE closing that door — from your workstation, not from here:

  ssh -i <private key> -p ${SSH_PORT} ${USER_NAME}@$(hostname -I | awk '{print $1}') 'docker info >/dev/null && echo ok'

Then:

  ssh root@$(hostname -I | awk '{print $1}') 'bash -s' -- harden --user ${USER_NAME} --ssh-port ${SSH_PORT} < server/bootstrap.sh
NEXT
}

# --------------------------------------------------------------------------------------------
# harden
# --------------------------------------------------------------------------------------------

harden() {
  id "$USER_NAME" >/dev/null 2>&1 || die $EXIT_CONFIG "user ${USER_NAME} does not exist; run prepare first."

  local auth="/home/${USER_NAME}/.ssh/authorized_keys"
  [ -s "$auth" ] || die $EXIT_CONFIG "${auth} is missing or empty; run prepare first."

  # The gate. Not "did you install a key" — keys get installed with a typo, into the wrong
  # user's home, with wrong permissions. Only sshd accepting one proves the door opens.
  if ! key_login_seen "$USER_NAME"; then
    die $EXIT_GATE "$(cat <<MSG
no successful key login by ${USER_NAME} has been recorded on this server.

Turning off passwords now would leave nothing that is known to work. Log in once from your
workstation and run harden again:

  ssh -i <private key> -p ${SSH_PORT} ${USER_NAME}@$(hostname -I | awk '{print $1}') 'docker info >/dev/null && echo ok'
MSG
)"
  fi
  say "key login by ${USER_NAME}: seen"

  runuser -u "$USER_NAME" -- docker info >/dev/null 2>&1 \
    || die $EXIT_GATE "${USER_NAME} cannot use docker; the deploy would refuse. Check the docker group, then run harden again."
  say "docker as ${USER_NAME}: ok"

  # A drop-in, not an edit of sshd_config: cloud-init owns one of these too. sshd takes the
  # FIRST value it obtains for a keyword and the includes are read in name order, so this has
  # to sort before 50-cloud-init.conf to win.
  cat > /etc/ssh/sshd_config.d/00-shipkit.conf <<CONF
# Written by shipkit's server/bootstrap.sh. Sorts first so it beats 50-cloud-init.conf.
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
# Root stays reachable by key, for the day the deploy user's key has to be replaced.
# It is the password door that gets closed, not the only way back in.
PermitRootLogin prohibit-password
Port ${SSH_PORT}
CONF
  chmod 600 /etc/ssh/sshd_config.d/00-shipkit.conf

  sshd -t || { rm -f /etc/ssh/sshd_config.d/00-shipkit.conf; die $EXIT_CONFIG "the new sshd config did not validate; nothing was changed."; }
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  say "passwords off, root by key only"

  report_state "$USER_NAME"

  cat <<NEXT

harden is done. Existing sessions stay open; test a new one before closing this terminal.

The deploy key still opens a shell, and ${USER_NAME} is in the docker group. Put it behind the
forced command next — it is undone in one command if it ever gets in the way:

  ssh root@$(hostname -I | awk '{print $1}') 'bash -s' -- restrict --user ${USER_NAME} < server/bootstrap.sh
NEXT
}


# --------------------------------------------------------------------------------------------
# restrict
#
# The private half of the deploy key lives in a CI secret store, so everyone who can start a
# workflow can open a session as this user — and this user is in the docker group, which is
# root on the machine. A forced command is what stands between the two.
#
# Three pieces, all root-owned and all outside the deploy user's home. That last part is the
# point: ~/.ssh/authorized_keys belongs to the deploy user, so a session that could write one
# file could lift its own restriction. The authorised key moves to /etc/ssh/authorized_keys.d,
# which the account cannot reach, and sshd is told to look there for this user only.
# --------------------------------------------------------------------------------------------

policy_line() {
  [ -r "$POLICY" ] && tr -d ' ' < "$POLICY" | grep -v '^#' | grep . | tr '\n' ' ' || echo "defaults"
}

write_dispatcher() {
  install -d -m 0755 -o root -g root "$(dirname "$DISPATCH")"
  cat > "$DISPATCH" <<'SHIPKIT_DISPATCH_EOF'
#!/usr/bin/env python3
"""
The forced command on the pipeline's deploy key.

The private half of that key lives in a CI secret store, so everyone who can start a workflow
can open this session. Without a forced command the session is a login shell for a user in the
docker group, which is root on the machine. This is what stands between the two.

It does not make the key unprivileged, and nothing here pretends otherwise: see POLICY below.
What it does is refuse the uses that are not a deploy, and write down every use that is.

Channels, told apart by SSH_ORIGINAL_COMMAND:

  unset            an interactive shell.        Refused outright.
  "sh"             shipkit's own channel: core/ssh-command.ts base64-encodes a script and pipes
                   it into a remote `sh`, so the command is always the bare word and the script
                   arrives on stdin. Allow-listed by shape (SHAPES) — default deny.
  "scp -t <path>"  the two uploads a deploy makes: a backup dump and a migration bundle.
                   Destination allow-listed; downloads (scp -f) refused.
  anything else    Kamal. Its commands are generated from the project's own config/deploy.yml,
                   so the set is open-ended and cannot be allow-listed honestly. Deny-listed
                   instead (FORBIDDEN_DOCKER_ARGS) — default allow, and logged.
"""

import os
import re
import sys
import hashlib
import shlex
import subprocess
import syslog

POLICY_FILE = "/etc/shipkit/deploy-key.policy"
MAX_STDIN = 1 << 20  # 1 MiB. Every script the pipeline sends is a few hundred bytes.

# Where the deploy is allowed to put files, and the only paths a bind mount may name.
BACKUP_ROOT = "/var/backups/shipkit"
BUNDLE_DIR = r"/tmp/shipkit-efbundle\.[A-Za-z0-9]{6,}"

# ---------------------------------------------------------------------------------------------
# Matching the shipkit channel
#
# Values reach these scripts through shq() (core/ssh-command.ts): left bare when they contain
# only characters no shell treats specially, single-quoted otherwise. Q matches both spellings,
# so a service or container name with a space in it is still recognised rather than refused for
# the wrong reason.
# ---------------------------------------------------------------------------------------------

Q = r"(?:'(?:[^']|'\\'')*'|[A-Za-z0-9_@%+=:,./-]+)"   # one shq()'d word
NAME = r"[A-Za-z0-9._-]+"                              # a service, container, user or database
BDIR = BACKUP_ROOT + "/" + NAME                        # backupDir(service)
PGC = NAME + r"\.pgc"                                  # backupFileName(...)
TMPPGC = r"\." + PGC + r"\.partial"

def _shape(pattern):
    return re.compile(r"\A" + pattern + r"\n?\Z", re.DOTALL)

# One entry per remote script the module can send, named after the function that builds it.
# A script that matches none of these is refused: the kit's rule is that a gate fails closed,
# and an unrecognised script on this channel is exactly the case the gate exists for.
SHAPES = {

  # core/server-probe.ts serverProbeScript
  "plan/server-probe": _shape(
    r"if ! docker info >/dev/null 2>&1; then echo docker:unavailable; exit 0; fi\n"
    r"echo docker:ok\n"
    r"state\(\) \{ s=\$\(docker inspect -f '\{\{\.State\.Status\}\}' \"\$1\" 2>/dev/null\) \|\| \{ echo missing; return; \}; "
    r"if \[ \"\$s\" = running \]; then echo running; else echo stopped; fi; \}\n"
    r"echo proxy:\$\(state kamal-proxy\)\n"
    r"(?:echo db:\$\(state " + Q + r"\)|echo db:missing)\n"
    r"echo app:\$\(docker ps -a -q --filter " + Q + r" \| wc -l \| tr -d ' '\)\n"
    r"echo arch:\$\(docker info --format '\{\{\.Architecture\}\}' 2>/dev/null\)"),

  # core/server-probe.ts containerVersionsScript
  "release/container-versions": _shape(
    r"echo containers:begin\n"
    r"docker ps -a --filter " + Q + r" --format '\{\{\.Names\}\}'\n"
    r"echo containers:end"),

  # core/history.ts runSql
  "history/run-sql": _shape(
    r"docker exec -i " + Q + r" psql -U " + Q + r" -d " + Q + r" -v ON_ERROR_STOP=1 -tA "
    r"<<'SHIPKIT_SQL'\n(?P<sql>.*)\nSHIPKIT_SQL\n"),

  # core/backup-store.ts tableCountScript — a different flag order from the one above, so it is
  # its own shape rather than a loosened version of it.
  "backup/table-count": _shape(
    r"docker exec -i " + Q + r" psql -v ON_ERROR_STOP=1 -U " + Q + r" -d " + Q + r" -tA "
    r"<<'SHIPKIT_SQL'\n(?P<sql>.*)\nSHIPKIT_SQL\n"),

  # core/backup.ts
  "backup/pg-dump": _shape(r"docker exec " + Q + r" pg_dump -Fc -U " + Q + r" " + Q),
  "backup/store-mkdir": _shape(r"umask 077 && mkdir -p " + BDIR + r" && test -w " + BDIR),
  "backup/store-sha256": _shape(r"sha256sum " + BDIR + "/" + TMPPGC),
  "backup/store-commit": _shape(
    r"chmod 600 " + BDIR + "/" + TMPPGC + r" && mv -f " + BDIR + "/" + TMPPGC + r" " + BDIR + "/" + PGC),
  "backup/store-cleanup": _shape(r"rm -f " + BDIR + "/" + TMPPGC),
  "backup/retention": _shape(r"cd " + BDIR + r" && rm -f --(?: " + PGC + r")+"),

  # core/backup-store.ts listingScript
  "backup/listing": _shape(
    r"\[ -d " + BDIR + r" \] \|\| \{ echo SHIPKIT_BACKUPS_NONE; exit 0; \}\n"
    r"cd " + BDIR + r" \|\| exit 3\n"
    r"for f in \*\.pgc; do \[ -f \"\$f\" \] \|\| continue; stat -c '%Y %s %n' \"\$f\" \|\| exit 3; done\n"
    r"echo SHIPKIT_BACKUPS_END"),

  # core/ssh-command.ts — the migration bundle's staging directory
  "migrate/mktemp": _shape(r"umask 077 && mktemp -d /tmp/shipkit-efbundle\.XXXXXX"),
  "migrate/rm-bundle-dir": _shape(r"rm -rf -- " + BUNDLE_DIR),

  # core/ssh-command.ts runBundleCommand. The connection string arrives as the assignment on the
  # first line and is never logged. The image and the mount are pinned down here: this is the one
  # shape on this channel that starts a container, so it is the one an attacker would want.
  "migrate/run-bundle": _shape(
    r"SHIPKIT_DSN_B64=[A-Za-z0-9+/=]*\n"
    r"set -e\n"
    r"dsn=\$\(printf '%s' \"\$SHIPKIT_DSN_B64\" \| base64 -d\)\n"
    r"\[ -n \"\$dsn\" \] \|\| \{ echo \"shipkit: the connection string arrived empty\" >&2; exit 1; \}\n"
    r"chmod \+x (?P<bundle>" + BUNDLE_DIR + r"/efbundle)\n"
    r"docker run --rm --network " + Q + r" (?:-e 'PGOPTIONS=[^']*' )?"
    r"-v (?P=bundle):/efbundle:ro "
    r"(?P<image>mcr\.microsoft\.com/dotnet/runtime-deps:[0-9.]+@sha256:[0-9a-f]{64}) "
    r"/efbundle --connection \"\$dsn\""),

  # core/deploy-lock.ts
  "lock/acquire": _shape(
    r"mkdir -p \"\$HOME/\.shipkit\"\n"
    r"if mkdir \"\$HOME/\.shipkit/deploy-lock-" + NAME + r"\" 2>/dev/null; then\n"
    r"  printf 'id=%s\\nsha=%s\\nenv=%s\\nactor=%s\\nserver_user=%s\\nsince=%s\\n' "
    r"'[A-Za-z0-9@._:+/-]{0,120}' '[A-Za-z0-9@._:+/-]{0,120}' '[A-Za-z0-9@._:+/-]{0,120}' "
    r"'[A-Za-z0-9@._:+/-]{0,120}' \"\$\(id -un\)\" \"\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)\" "
    r"> \"\$HOME/\.shipkit/deploy-lock-" + NAME + r"/holder\" \|\| "
    r"\{ rm -rf \"\$HOME/\.shipkit/deploy-lock-" + NAME + r"\"; exit 1; \}\n"
    r"  echo ACQUIRED\nelse\n  echo HELD\n"
    r"  cat \"\$HOME/\.shipkit/deploy-lock-" + NAME + r"/holder\" 2>/dev/null \|\| "
    r"echo \"holder=unknown \(no holder file\)\"\nfi"),
  "lock/release": _shape(
    r"if grep -qx 'id=[A-Za-z0-9@._:+/-]{0,120}' \"\$HOME/\.shipkit/deploy-lock-" + NAME + r"/holder\" 2>/dev/null; then\n"
    r"  rm -rf \"\$HOME/\.shipkit/deploy-lock-" + NAME + r"\" && echo RELEASED\nelse\n  echo NOT-OURS\nfi"),

  # core/postgres-remote.ts waitForDatabase
  "db/wait-for-database": _shape(
    r"i=0; while \[ \$i -lt [0-9]{1,4} \]; do "
    r"docker exec " + Q + r" pg_isready -h 127\.0\.0\.1 -U " + Q + r" -d " + Q + r" >/dev/null 2>&1 && exit 0; "
    r"i=\$\(\(i\+1\)\); sleep 1; done; exit 1"),
}

# psql reads lines beginning with a backslash as its own meta-commands, and `\!` runs a shell
# command inside the database container. The two shapes that carry SQL are the only place a
# caller chooses the text, so the text is checked rather than trusted.
PSQL_META = re.compile(r"^\s*\\", re.MULTILINE)

# ---------------------------------------------------------------------------------------------
# Matching the scp channel
# ---------------------------------------------------------------------------------------------

SCP_TARGETS = [
    re.compile(r"\A" + BACKUP_ROOT + "/" + NAME + "/" + TMPPGC + r"\Z"),  # core/backup.ts persist
    re.compile(r"\A" + BUNDLE_DIR + r"/efbundle\Z"),                      # core/ssh-command.ts
]

# ---------------------------------------------------------------------------------------------
# The Kamal channel
#
# Kamal builds its commands from the project's config/deploy.yml, which lives in the repository
# the workflow runs from. Allow-listing a set the caller writes would be a list of whatever the
# caller wanted, so this is a deny-list of the arguments that turn "start the app's container"
# into "read the host's disk" — and it is a deny-list, which is weaker than a gate. Said plainly
# here so nobody reads the log's "allowed" as "checked".
# ---------------------------------------------------------------------------------------------

FORBIDDEN_DOCKER_ARGS = [
    (re.compile(r"(?:^|\s)--privileged(?:\s|$)"), "--privileged"),
    (re.compile(r"(?:^|\s)--(?:pid|ipc|uts|userns|cgroupns)=host(?:\s|$)"), "a host namespace"),
    (re.compile(r"(?:^|\s)--cap-add(?:=|\s)"), "--cap-add"),
    (re.compile(r"(?:^|\s)--device(?:=|\s)"), "--device"),
    (re.compile(r"(?:^|\s)--security-opt(?:=|\s)"), "--security-opt"),
]

# Where a bind mount may come from. Kamal writes the files an accessory declares under the
# deploy user's own ~/.kamal and mounts them from there, so that directory has to stay usable —
# refusing it outright turns a real deploy red at the accessory, which is the failure this
# whole exercise is supposed to avoid. Everything else absolute is refused; a name with no
# leading slash is a Docker volume, which cannot reach the host's filesystem.
MOUNT_ROOTS = (
    (os.path.expanduser("~") if os.path.expanduser("~") != "~" else "/home/deploy") + "/.kamal/",
    BACKUP_ROOT + "/",
    "/tmp/shipkit-efbundle.",
)

# -v/--volume: <source>:<target>[:opts]. --mount: key=value pairs, source= or src=.
_V = re.compile(r"(?:^|\s)(?:-v|--volume)[= ]'?([^\s'&|;]+)")
_M = re.compile(r"(?:^|\s)--mount[= ]'?([^\s'&|;]+)")


def mount_sources(command):
    """Every host path a command would bind-mount. Docker volume names are not paths."""
    found = []
    for spec in _V.findall(command):
        source = spec.split(":", 1)[0]
        if source.startswith("/"):
            found.append(source)
    for spec in _M.findall(command):
        for part in spec.split(","):
            k, _, v = part.partition("=")
            if k.strip() in ("source", "src") and v.startswith("/"):
                found.append(v)
    return found


def decide_kamal(command):
    if "docker.sock" in command:
        return False, "kamal/forbidden", "the docker socket"
    for pattern, what in FORBIDDEN_DOCKER_ARGS:
        if pattern.search(command):
            return False, "kamal/forbidden", what
    for source in mount_sources(command):
        # Normalised first: /home/deploy/.kamal/../../../etc is not ~/.kamal.
        if ".." in source.split("/") or not os.path.normpath(source).startswith(MOUNT_ROOTS):
            return False, "kamal/forbidden", "a bind mount of " + source
    return True, "kamal/passed", ""


def policy():
    """Per-channel mode, from POLICY_FILE. Built-in defaults when it is absent."""
    modes = {"shipkit": "enforce", "kamal": "enforce"}
    try:
        with open(POLICY_FILE) as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if "=" in line:
                    k, v = (p.strip() for p in line.split("=", 1))
                    if k in modes and v in ("enforce", "audit"):
                        modes[k] = v
    except OSError:
        pass
    return modes


def log(decision, channel, detail, command, digest=None):
    where = (os.environ.get("SSH_CONNECTION") or "?").split(" ")[0]
    parts = ["decision=" + decision, "channel=" + channel, "from=" + where]
    if digest:
        parts.append("stdin_sha256=" + digest)
    if detail:
        parts.append("detail=" + detail.replace("\n", " ")[:400])
    parts.append("cmd=" + (command or "<none>").replace("\n", " ")[:400])
    syslog.syslog(syslog.LOG_NOTICE, " ".join(parts))


def refuse(message):
    sys.stderr.write(
        "shipkit: this key is restricted to deploying, and that is not a deploy.\n"
        "  " + message + "\n"
        "  What it may do, and how to widen it: docs/runbooks/deploy-key.md on the kit.\n")
    sys.exit(1)


def read_stdin():
    data = sys.stdin.buffer.read(MAX_STDIN + 1)
    if len(data) > MAX_STDIN:
        return None
    return data


def match_shipkit(script):
    for name, pattern in SHAPES.items():
        m = pattern.match(script)
        if not m:
            continue
        sql = m.groupdict().get("sql")
        if sql is not None and PSQL_META.search(sql):
            return None, name + ": the SQL carries a psql meta-command (a line starting with a backslash)"
        return name, ""
    return None, "the script is not one this key sends"


def main():
    syslog.openlog("shipkit-deploy-key", syslog.LOG_PID, syslog.LOG_AUTHPRIV)
    command = os.environ.get("SSH_ORIGINAL_COMMAND")
    modes = policy()

    # 1. An interactive shell. Nothing the pipeline does needs one.
    if not command:
        log("refused", "shell", "interactive session", command)
        refuse("This key has no shell. Log in as root with an admin key to use one.")

    # 2. sftp. `restrict` does not cover the subsystem, and it is a file transfer with no
    #    destination for this dispatcher to check.
    if command.startswith("internal-sftp") or "sftp-server" in command:
        log("refused", "sftp", "sftp subsystem", command)
        refuse("This key cannot use sftp. A deploy uploads through scp, to two known paths.")

    # 3. shipkit's own channel: the bare word `sh`, script on stdin.
    if command.strip() in ("sh", "/bin/sh", "/usr/bin/sh"):
        raw = read_stdin()
        if raw is None:
            log("refused", "shipkit", "stdin over %d bytes" % MAX_STDIN, command)
            refuse("The script is larger than anything this pipeline sends.")
        digest = hashlib.sha256(raw).hexdigest()[:16]
        try:
            script = raw.decode("utf-8")
        except UnicodeDecodeError:
            log("refused", "shipkit", "stdin is not utf-8", command, digest)
            refuse("The script is not text.")
        name, why = match_shipkit(script)
        if name is None and modes["shipkit"] == "enforce":
            # The script itself goes to the log, so the next person can see what was sent and
            # add a shape if the pipeline grew one. It never carries a secret: the one script
            # that does is matched before this, and its secret is on its own line.
            log("refused", "shipkit", why + " || " + script[:600], command, digest)
            refuse(why + "\n  The script was logged (journalctl -t shipkit-deploy-key).")
        log("allowed" if name else "audited", "shipkit", name or why, command, digest)
        # The bytes have already been read here, so they are handed to sh on stdin rather than
        # the connection being passed through. sh's own stdout and stderr stay the session's.
        sys.exit(subprocess.run(["/bin/sh"], input=raw).returncode)

    # 4. scp. Uploads to two known destinations; downloads refused outright, so the key cannot
    #    be used to copy anything off the machine.
    if re.match(r"\Ascp(\s|$)", command):
        try:
            argv = shlex.split(command)
        except ValueError:
            log("refused", "scp", "unparseable", command)
            refuse("That scp command could not be read.")
        if "-f" in argv:
            log("refused", "scp", "download", command)
            refuse("This key cannot copy files off the server.")
        if "-t" not in argv:
            log("refused", "scp", "not an upload", command)
            refuse("Only scp uploads are allowed.")
        target = argv[-1]
        if not any(p.match(target) for p in SCP_TARGETS):
            log("refused", "scp", "destination " + target, command)
            refuse("A deploy uploads only to %s/<service>/ and to a migration bundle's staging\n"
                   "  directory. That destination is neither." % BACKUP_ROOT)
        log("allowed", "scp", target, command)
        os.execvp("scp", argv)

    # 5. Kamal.
    ok, channel, what = decide_kamal(command)
    if not ok and modes["kamal"] == "enforce":
        log("refused", channel, what, command)
        refuse("That command carries %s. A deploy does not need it, and it is how a container\n"
               "  becomes root on the host." % what)
    log("allowed" if ok else "audited", channel, what, command)
    os.execv("/bin/sh", ["sh", "-c", command])


if __name__ == "__main__":
    main()
SHIPKIT_DISPATCH_EOF
  chown root:root "$DISPATCH"
  chmod 0755 "$DISPATCH"
  python3 -c "import ast,sys; ast.parse(open('$DISPATCH').read())" \
    || die $EXIT_INFRA "the dispatcher did not parse; nothing was activated."
}

# The dispatcher decides for itself, so it is asked directly — not over SSH, where a mistake
# would be discovered by being locked out. One script that must be allowed and one that must
# not; either answer being wrong means the restriction does not do what it says.
self_test() {
  local probe refused out
  probe='umask 077 && mktemp -d /tmp/shipkit-efbundle.XXXXXX'
  # SSH_ORIGINAL_COMMAND=sh is shipkit's channel: the script arrives on stdin.
  out=$(printf '%s' "$probe" | SSH_ORIGINAL_COMMAND=sh "$DISPATCH" 2>&1) || {
    printf '%s\n' "$out" >&2
    return 1
  }
  case "$out" in
    /tmp/shipkit-efbundle.*) rm -rf -- "$out" ;;
    *) printf 'the allowed probe did not produce a staging directory: %s\n' "$out" >&2; return 1 ;;
  esac
  refused=$(printf 'cat /etc/shadow' | SSH_ORIGINAL_COMMAND=sh "$DISPATCH" 2>&1) && {
    printf 'a script that is not a deploy was ALLOWED: %s\n' "$refused" >&2
    return 1
  }
  # And no shell at all.
  SSH_ORIGINAL_COMMAND= "$DISPATCH" >/dev/null 2>&1 && {
    printf 'an interactive session was ALLOWED\n' >&2
    return 1
  }
  return 0
}

restrict() {
  id "$USER_NAME" >/dev/null 2>&1 || die $EXIT_CONFIG "user ${USER_NAME} does not exist; run prepare first."
  command -v python3 >/dev/null 2>&1 || die $EXIT_CONFIG "python3 is required by the dispatcher and is not installed."

  local auth="/home/${USER_NAME}/.ssh/authorized_keys"
  [ -s "$auth" ] || die $EXIT_CONFIG "${auth} is missing or empty; run prepare first."

  # The same gate harden uses, for the same reason: restricting a key that has never been seen
  # to work means the next failure has two possible causes instead of one.
  key_login_seen "$USER_NAME" \
    || die $EXIT_GATE "no successful key login by ${USER_NAME} has been recorded. Log in with the key once, then run restrict."

  step "1/4  dispatcher"
  write_dispatcher
  say "installed ${DISPATCH}"

  step "2/4  policy"
  install -d -m 0755 -o root -g root "$(dirname "$POLICY")"
  if [ -f "$POLICY" ]; then
    say "kept the policy already on this server: $(policy_line)"
  else
    cat > "$POLICY" <<'POLICY_EOF'
# How each channel of the deploy key is treated.
#   enforce  refuse what the rules do not allow
#   audit    allow it, and write it down (journalctl -t shipkit-deploy-key)
#
# Switch a channel to audit when a pipeline change starts being refused and you need to see
# what it now sends. Audit is not a gate — nothing is being stopped while it is set.
shipkit=enforce
kamal=enforce
POLICY_EOF
    chmod 0644 "$POLICY"
    say "wrote ${POLICY} (shipkit=enforce kamal=enforce)"
  fi

  step "3/4  the authorised key, out of ${USER_NAME}'s reach"
  install -d -m 0755 -o root -g root "$KEYS_DIR"
  # Copied, not moved. ~/.ssh/authorized_keys stays exactly as it was, so `unrestrict` is one
  # command and does not have to put a key back.
  install -m 0644 -o root -g root /dev/null "${KEYS_DIR}/${USER_NAME}"
  {
    printf '# Written by shipkit server/bootstrap.sh restrict. Root-owned on purpose: %s\n' "$USER_NAME"
    printf '# must not be able to lift its own restriction. The forced command is in %s.\n' "$SSHD_DROPIN"
    # restrict = no port forwarding, no agent forwarding, no X11, no PTY, no user rc.
    # Key lines only: a comment or a blank line prefixed with an option is a parse error, and
    # sshd reports it as "authentication refused" with nothing to say why.
    grep -E '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)' "$auth" | sed -e 's/^/restrict /'
  } > "${KEYS_DIR}/${USER_NAME}"
  chmod 0644 "${KEYS_DIR}/${USER_NAME}"
  say "$(grep -c '^restrict ' "${KEYS_DIR}/${USER_NAME}") key(s) copied to ${KEYS_DIR}/${USER_NAME}"

  step "4/4  sshd"
  cat > "$SSHD_DROPIN" <<CONF
# Written by shipkit's server/bootstrap.sh restrict.
#
# Remove this file and reload sshd to undo everything restrict did:
#   rm -f ${SSHD_DROPIN} && sshd -t && systemctl reload ssh
# ${USER_NAME} then goes back to /home/${USER_NAME}/.ssh/authorized_keys, unrestricted.
Match User ${USER_NAME}
  AuthorizedKeysFile ${KEYS_DIR}/%u
  ForceCommand ${DISPATCH}
  PermitTTY no
  AllowTcpForwarding no
  AllowAgentForwarding no
  AllowStreamLocalForwarding no
  X11Forwarding no
  PermitOpen none
CONF
  chmod 0644 "$SSHD_DROPIN"
  sshd -t || { rm -f "$SSHD_DROPIN"; die $EXIT_CONFIG "the new sshd config did not validate; nothing was changed."; }

  self_test || { rm -f "$SSHD_DROPIN"; die $EXIT_GATE "the dispatcher failed its own self-test; the restriction was NOT activated."; }
  say "self-test: a deploy script is allowed, anything else and an interactive session are not"

  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  say "sshd reloaded"

  report_state "$USER_NAME"

  cat <<NEXT

restrict is done. Existing sessions keep whatever they already had; test a NEW one.

Prove it from your workstation, before you need it to work:

  ssh -i <deploy key> ${USER_NAME}@$(hostname -I | awk '{print $1}')                     # must be refused
  ssh -i <deploy key> ${USER_NAME}@$(hostname -I | awk '{print $1}') 'cat /etc/shadow'   # must be refused
  printf 'echo containers:begin\ndocker ps -a --filter x --format y\necho containers:end' \
    | ssh -i <deploy key> ${USER_NAME}@$(hostname -I | awk '{print $1}') sh              # must work

Every decision is written down:  journalctl -t shipkit-deploy-key

If the pipeline goes red on something it used to do, the log says what was sent. Undo, as root:

  ssh root@$(hostname -I | awk '{print $1}') 'rm -f ${SSHD_DROPIN} && sshd -t && systemctl reload ssh'
NEXT
}

unrestrict() {
  [ -f "$SSHD_DROPIN" ] || { say "not restricted; nothing to undo"; return 0; }
  rm -f "$SSHD_DROPIN"
  sshd -t || die $EXIT_CONFIG "sshd config does not validate after removing ${SSHD_DROPIN}; look before reloading."
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  say "removed ${SSHD_DROPIN} and reloaded sshd"
  say "${USER_NAME} is back on /home/${USER_NAME}/.ssh/authorized_keys, with a shell"
  say "the dispatcher is still at ${DISPATCH}; run restrict to switch it back on"
  report_state "$USER_NAME"
}

case "$PHASE" in
  prepare)    prepare ;;
  harden)     harden ;;
  restrict)   restrict ;;
  unrestrict) unrestrict ;;
  check)      report_state "$USER_NAME" ;;
  *)          usage ;;
esac
