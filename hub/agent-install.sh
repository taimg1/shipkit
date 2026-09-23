#!/usr/bin/env bash
#
# Installs the status agent on a watched server: a key, a pinned hub host key, and a timer.
#
# Run as root on the server being watched. It creates nothing on the hub — the last thing it
# prints is the public key, and a person authorises that on the hub. Connecting a server is
# deliberately two steps on two machines: an installer that could also authorise itself would
# mean the hub trusts whoever can run an installer.
#
# Usage, from a workstation with the repository checked out:
#
#   ssh root@HUB 'ssh-keyscan -t ed25519 localhost 2>/dev/null | ssh-keygen -lf -'   # the fingerprint
#   tar -cz hub | ssh root@SERVER 'mkdir -p /tmp/shipkit-agent-src && tar -xz -C /tmp/shipkit-agent-src'
#   ssh root@SERVER 'bash /tmp/shipkit-agent-src/hub/agent-install.sh \
#       --name SERVER-NAME --hub HUB-IP --hub-fingerprint SHA256:...'
#
# Idempotent: the key and the pinned host key are kept, the code and the units are replaced.

set -euo pipefail

EXIT_GATE=1
EXIT_CONFIG=2

ETC=/etc/shipkit-agent
LIB=/usr/local/lib/shipkit-agent
NAME=""
HUB=""
HUB_USER=shipkit-hub
FINGERPRINT=""
HEALTH_URL=""
SERVICE=""
DEPLOY_USER=deploy

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
die()  { local code=$1; shift; printf '\nERROR: %s\n' "$*" >&2; exit "$code"; }

usage() {
  cat >&2 <<'USAGE'
usage: agent-install.sh --name <server-name> --hub <hub host> --hub-fingerprint SHA256:...
                       [--hub-user shipkit-hub] [--health-url http://127.0.0.1:3000/health]
                       [--service <kamal service>] [--deploy-user deploy]
USAGE
  exit 2
}

SRC=$(cd "$(dirname "$0")" && pwd)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)            NAME=${2-}; shift 2 ;;
    --hub)             HUB=${2-}; shift 2 ;;
    --hub-user)        HUB_USER=${2-}; shift 2 ;;
    --hub-fingerprint) FINGERPRINT=${2-}; shift 2 ;;
    --health-url)      HEALTH_URL=${2-}; shift 2 ;;
    --service)         SERVICE=${2-}; shift 2 ;;
    --deploy-user)     DEPLOY_USER=${2-}; shift 2 ;;
    -h|--help)         usage ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die $EXIT_CONFIG "run this as root on the server to be watched."
printf '%s' "$NAME" | grep -qE '^[a-z0-9][a-z0-9_-]{0,62}$' \
  || die $EXIT_CONFIG "--name must be lowercase letters, digits, dash or underscore."
[ -n "$HUB" ] || die $EXIT_CONFIG "--hub is required."
[ -n "$FINGERPRINT" ] || die $EXIT_CONFIG "--hub-fingerprint is required. Take it from the hub itself:
  ssh root@${HUB} 'ssh-keyscan -t ed25519 localhost 2>/dev/null | ssh-keygen -lf -'"
command -v ssh >/dev/null || die $EXIT_CONFIG "openssh-client is not installed."
command -v python3 >/dev/null || die $EXIT_CONFIG "python3 is not installed."

step "1/4  code"
install -d -m 755 "$LIB" "$ETC"
install -m 755 "${SRC}/agent.py" "${LIB}/agent"
say "${LIB}/agent"

step "2/4  key"
if [ -s "${ETC}/id_ed25519" ]; then
  say "keeping the existing key (revoke it on the hub before replacing it)"
else
  ssh-keygen -t ed25519 -N '' -C "shipkit-agent ${NAME}" -f "${ETC}/id_ed25519" -q
  say "generated ${ETC}/id_ed25519"
fi
chmod 600 "${ETC}/id_ed25519"

step "3/4  the hub's host key"
# Scanned, then checked against a fingerprint the operator got from the hub over a channel
# that is already trusted. Scanning alone is trust-on-first-use, which is exactly the moment
# an interception would be invisible — the kit refuses it elsewhere too (ADR/known-hosts).
scanned=$(ssh-keyscan -t ed25519 -T 10 "$HUB" 2>/dev/null | grep -v '^#' || true)
[ -n "$scanned" ] || die $EXIT_GATE "no ed25519 host key answered at ${HUB}:22."
got=$(printf '%s\n' "$scanned" | ssh-keygen -lf - | awk '{print $2}')
if [ "$got" != "$FINGERPRINT" ]; then
  die $EXIT_GATE "$(cat <<MSG
the hub's host key is not the one you pinned.

  expected  ${FINGERPRINT}
  answering ${got}

Nothing was installed. Treat this as possible interception: take the fingerprint from the
hub's own console, not from this output.
MSG
)"
fi
printf '%s\n' "$scanned" > "${ETC}/known_hosts"
chmod 644 "${ETC}/known_hosts"
say "pinned ${got}"

step "4/4  configuration and timer"
cat > "${ETC}/agent.env" <<CONF
# Written by shipkit's hub/agent-install.sh. Read by the agent and by systemd.
SHIPKIT_AGENT_NAME=${NAME}
SHIPKIT_HUB_HOST=${HUB}
SHIPKIT_HUB_USER=${HUB_USER}
SHIPKIT_AGENT_KEY=${ETC}/id_ed25519
SHIPKIT_AGENT_KNOWN_HOSTS=${ETC}/known_hosts
SHIPKIT_DEPLOY_USER=${DEPLOY_USER}
SHIPKIT_BACKUP_ROOT=/var/backups/shipkit
SHIPKIT_SERVICE=${SERVICE}
SHIPKIT_HEALTH_URL=${HEALTH_URL}
CONF
chmod 644 "${ETC}/agent.env"
install -m 644 "${SRC}/systemd/shipkit-agent.service" /etc/systemd/system/shipkit-agent.service
install -m 644 "${SRC}/systemd/shipkit-agent.timer" /etc/systemd/system/shipkit-agent.timer
systemctl daemon-reload
systemctl enable --now shipkit-agent.timer >/dev/null
say "shipkit-agent.timer: $(systemctl is-active shipkit-agent.timer)"

cat <<NEXT

Authorise this server on the hub — it cannot authorise itself:

  ssh root@${HUB} "shipkit-hub-client add ${NAME} '$(cat "${ETC}/id_ed25519.pub")'"

Then watch the first push land:

  systemctl start shipkit-agent.service && journalctl -u shipkit-agent -n 20 --no-pager
NEXT
