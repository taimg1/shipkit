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
#
# Usage, from a workstation:
#
#   ssh root@HOST 'bash -s' -- prepare --key "$(cat ~/.ssh/shipkit_deploy.pub)" < server/bootstrap.sh
#   ssh -i ~/.ssh/shipkit_deploy deploy@HOST 'docker info >/dev/null && echo ok'
#   ssh root@HOST 'bash -s' -- harden < server/bootstrap.sh
#
# Every phase is idempotent: running it twice changes nothing the second time.

set -euo pipefail

# The kit's exit codes (docs/cli-design.md): 1 a gate said no, 2 configuration, 3 infrastructure.
EXIT_GATE=1
EXIT_CONFIG=2
EXIT_INFRA=3

USER_NAME=deploy
SSH_PORT=22
SWAP_SIZE=2G
PUBKEY=""

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
die()  { local code=$1; shift; printf '\nERROR: %s\n' "$*" >&2; exit "$code"; }

usage() {
  cat >&2 <<'USAGE'
usage: bootstrap.sh prepare --key "<ssh public key>" [--user deploy] [--ssh-port 22] [--swap 2G]
       bootstrap.sh harden  [--user deploy] [--ssh-port 22]
       bootstrap.sh check   [--user deploy]
USAGE
  exit 2
}

[ "$#" -ge 1 ] || usage
PHASE=$1; shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --key)      PUBKEY=${2-}; shift 2 ;;
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
  local u=$1
  journalctl -u ssh -u sshd --no-pager -q 2>/dev/null | grep -q "Accepted publickey for ${u} " && return 0
  grep -qs "Accepted publickey for ${u} " /var/log/auth.log /var/log/auth.log.1 && return 0
  return 1
}

report_state() {
  local u=$1
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
  printf '  %-22s %s\n' "firewall" "$(ufw status 2>/dev/null | head -1 | sed 's/^Status: //' || echo 'not installed')"
  printf '  %-22s %s\n' "root login" "$(sshd -T 2>/dev/null | awk '/^permitrootlogin/{print $2}')"
  printf '  %-22s %s\n' "password auth" "$(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
  if key_login_seen "$u"; then
    printf '  %-22s %s\n' "key login by ${u}" "seen"
  else
    printf '  %-22s %s\n' "key login by ${u}" "never (harden will refuse)"
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
    port=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')
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
  [ -n "$PUBKEY" ] || die $EXIT_CONFIG "--key is required: the public half of the key the pipeline will deploy with."
  case "$PUBKEY" in
    ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *|sk-ssh-*\ *) ;;
    *) die $EXIT_CONFIG "--key does not look like an SSH public key. Pass the .pub file's contents, not a path." ;;
  esac

  export DEBIAN_FRONTEND=noninteractive

  step "1/7  packages"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades >/dev/null
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
  if id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx docker; then
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

  cat <<NEXT

prepare is done. Root and password login are still on, deliberately.

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
NEXT
}

case "$PHASE" in
  prepare) prepare ;;
  harden)  harden ;;
  check)   report_state "$USER_NAME" ;;
  *)       usage ;;
esac

# ---- status hub hook --------------------------------------------------------------------
# Additive and in one block on purpose: this file is being rewritten on another branch, and a
# block appended at the end merges cleanly where an edit inside prepare() would not.
#
# The agent is not installed from here. hub/agent-install.sh needs the hub's host-key
# fingerprint and the hub/ directory, and this script is piped in over ssh with neither. So
# this is a pointer, printed at the moment someone is looking at a freshly prepared server.
case "$PHASE" in
  prepare|harden)
    cat <<'HUB'

To have this server report to the status hub (docs/runbooks/status-hub.md):

  ssh root@<hub> 'ssh-keyscan -t ed25519 localhost 2>/dev/null | ssh-keygen -lf -'
  tar -cz hub | ssh root@<this server> 'mkdir -p /tmp/agent-src && tar -xz -C /tmp/agent-src'
  ssh root@<this server> 'bash /tmp/agent-src/hub/agent-install.sh --name <name> \
      --hub <hub> --hub-fingerprint SHA256:... --service <service> --health-url <url>'

Then authorise the key it prints, on the hub:  shipkit-hub-client add <name> '<key>'
HUB
    ;;
esac
# ---- end status hub hook ----------------------------------------------------------------
