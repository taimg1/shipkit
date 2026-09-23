#!/usr/bin/env bash
#
# Installs the status hub: the SSH ingest door and the Telegram bot.
#
# The hub is one machine that is not any of the machines it watches, so that the thing which
# notices a server is gone does not go with it (docs/runbooks/monitoring.md says the same
# about Uptime Kuma, and for the same reason).
#
# Two users, because they need different things and a compromise of one should not hand over
# the other:
#
#   shipkit-hub   the SSH door. Reachable from every watched server, holds no secret, and can
#                 only ever run the forced command. Writes snapshots.
#   shipkit-bot   the Telegram bot. Holds the token, has no key and no login shell, and is
#                 not reachable from outside at all — long polling is outbound.
#
# Usage, from a workstation with the repository checked out:
#
#   tar -cz hub | ssh root@HUB 'mkdir -p /tmp/shipkit-hub-src && tar -xz -C /tmp/shipkit-hub-src'
#   ssh root@HUB 'bash /tmp/shipkit-hub-src/hub/hub-install.sh'
#
# Idempotent: running it again reinstalls the code and leaves users, keys and snapshots alone.

set -euo pipefail

EXIT_GATE=1
EXIT_CONFIG=2

HUB_USER=shipkit-hub
BOT_USER=shipkit-bot
LIB=/usr/local/lib/shipkit-hub
STATE=/var/lib/shipkit-hub
ENV_FILE=/etc/shipkit-hub/telegram.env
AUTH=/etc/ssh/authorized_keys.d/${HUB_USER}
DROPIN=/etc/ssh/sshd_config.d/20-shipkit-hub.conf

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
die()  { local code=$1; shift; printf '\nERROR: %s\n' "$*" >&2; exit "$code"; }

SRC=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" -eq 0 ] || die $EXIT_CONFIG "run this as root on the hub."
for f in statuslib.py ingest.py bot.py; do
  [ -r "${SRC}/${f}" ] || die $EXIT_CONFIG "${SRC}/${f} is missing; copy the whole hub/ directory over."
done

step "1/5  users"
# A login shell, not nologin: sshd execs the forced command through the user's shell, and a
# nologin shell would refuse every snapshot with no useful message anywhere.
id "$HUB_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$STATE" --shell /bin/bash "$HUB_USER"
id "$BOT_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$BOT_USER"
install -d -o "$HUB_USER" -g "$HUB_USER" -m 755 "$STATE" "${STATE}/snapshots"
install -d -o "$BOT_USER" -g "$BOT_USER" -m 700 "${STATE}/state"
say "${HUB_USER} (ingest), ${BOT_USER} (bot)"

step "2/5  code"
install -d -m 755 "$LIB"
install -m 644 "${SRC}/statuslib.py" "${LIB}/statuslib.py"
install -m 755 "${SRC}/ingest.py" "${LIB}/ingest"
install -m 755 "${SRC}/bot.py" "${LIB}/bot"
install -m 755 "${SRC}/hub-client.sh" /usr/local/bin/shipkit-hub-client
say "${LIB}/{ingest,bot,statuslib.py}, /usr/local/bin/shipkit-hub-client"

step "3/5  the ingest door"
install -d -m 755 /etc/ssh/authorized_keys.d
# Root-owned and outside the user's home on purpose: the client name that decides which
# snapshot gets overwritten is in these lines, so the account that receives snapshots must
# not be able to edit them.
[ -f "$AUTH" ] || install -m 644 /dev/null "$AUTH"
cat > "$DROPIN" <<CONF
# Written by shipkit's hub/hub-install.sh. Belt and braces around the per-key restrictions
# in ${AUTH}: even a line that lost its \`restrict\` cannot get a shell or a forward.
#
# There is deliberately no ForceCommand here. sshd's own forced command wins over the one in
# authorized_keys, and this one could not know which client connected — the client name is an
# argument of the authorized_keys command, which is the only thing that ties a snapshot to a key.
#
# Remove this file and reload sshd to undo it:
#   rm -f ${DROPIN} && sshd -t && systemctl reload ssh
Match User ${HUB_USER}
  AuthorizedKeysFile ${AUTH}
  PermitTTY no
  AllowTcpForwarding no
  AllowAgentForwarding no
  AllowStreamLocalForwarding no
  X11Forwarding no
  PermitOpen none
CONF
chmod 600 "$DROPIN"
sshd -t || { rm -f "$DROPIN"; die $EXIT_CONFIG "the new sshd config did not validate; nothing was changed."; }
systemctl reload ssh 2>/dev/null || systemctl reload sshd
say "sshd validated and reloaded (reload, never restart: open sessions survive)"

step "4/5  the bot"
if [ ! -s "$ENV_FILE" ]; then
  die $EXIT_GATE "$(cat <<MSG
${ENV_FILE} is missing. The bot needs it and this script will not invent one.

  install -d -m 700 /etc/shipkit-hub
  printf 'TELEGRAM_BOT_TOKEN=...\nTELEGRAM_CHAT_ID=...\n' > ${ENV_FILE}
  chmod 600 ${ENV_FILE}
MSG
)"
fi
# systemd reads the token as root and hands it to the bot's environment, so the file itself
# stays 0600 root and the bot user never has permission to open it.
install -m 644 "${SRC}/systemd/shipkit-hub-bot.service" /etc/systemd/system/shipkit-hub-bot.service
systemctl daemon-reload
systemctl enable --now shipkit-hub-bot.service >/dev/null
say "shipkit-hub-bot.service: $(systemctl is-active shipkit-hub-bot.service)"

step "5/5  state"
printf '  clients authorised: %s\n' "$(grep -c '^[^#]' "$AUTH" 2>/dev/null || true)"
printf '  snapshots held:     %s\n' "$(ls -1 "${STATE}/snapshots" 2>/dev/null | wc -l)"

cat <<NEXT

The hub is up. Connect a server to it:

  ssh root@<server> 'bash -s' -- --name <name> --hub $(hostname -I | awk '{print $1}') < hub/agent-install.sh

which prints the public key to authorise here:

  shipkit-hub-client add <name> '<public key>'
NEXT
