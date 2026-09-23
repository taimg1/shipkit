#!/usr/bin/env bash
#
# Authorises, lists and revokes the keys that may push snapshots to this hub.
#
# One line per client, and the client's name is an argument of its forced command. That is
# what makes a snapshot attributable: the name comes from which key opened the session, so a
# client cannot write another client's snapshot however it frames the payload.
#
#   shipkit-hub-client add <name> '<ssh public key>'
#   shipkit-hub-client remove <name>
#   shipkit-hub-client list

set -euo pipefail

AUTH=/etc/ssh/authorized_keys.d/shipkit-hub
SNAPSHOTS=/var/lib/shipkit-hub/snapshots
INGEST=/usr/local/lib/shipkit-hub/ingest

die() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || die "run this as root on the hub."

usage() { sed -n '/^#   shipkit-hub-client/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

valid_name() { printf '%s' "$1" | grep -qE '^[a-z0-9][a-z0-9_-]{0,62}$'; }

case "${1-}" in
  add)
    name=${2-}; key=${3-}
    valid_name "$name" || die "name must be lowercase letters, digits, dash or underscore."
    [ -n "$key" ] || die "give the client's public key as the third argument."
    printf '%s' "$key" | grep -qE '^(ssh-ed25519|ecdsa-sha2-nistp[0-9]+|ssh-rsa) [A-Za-z0-9+/=]+' \
      || die "that does not look like an SSH public key."
    touch "$AUTH"
    grep -q "shipkit-hub/ingest ${name}\"" "$AUTH" && die "${name} is already authorised; remove it first."
    # `restrict` turns everything off and keeps doing so as OpenSSH gains new features, which
    # an explicit list of no-* options does not.
    printf 'command="%s %s",restrict %s shipkit-hub client %s\n' \
      "$INGEST" "$name" "$(printf '%s' "$key" | awk '{print $1" "$2}')" "$name" >> "$AUTH"
    chmod 644 "$AUTH"
    printf 'authorised %s\n' "$name"
    ;;
  remove)
    name=${2-}
    valid_name "$name" || die "name must be lowercase letters, digits, dash or underscore."
    grep -q "shipkit-hub/ingest ${name}\"" "$AUTH" 2>/dev/null || die "${name} is not authorised."
    tmp=$(mktemp)
    # `|| true`: grep -v exits 1 when it prints nothing, which is exactly the case of
    # revoking the last client — and under `set -e` that silently left the line in place.
    grep -v "shipkit-hub/ingest ${name}\"" "$AUTH" > "$tmp" || true
    cat "$tmp" > "$AUTH"; rm -f "$tmp"
    # The snapshot goes too. Leaving it would make a disconnected server look silent forever,
    # and /status would keep listing a machine nobody is watching any more.
    rm -f "${SNAPSHOTS}/${name}.json"
    printf 'revoked %s and dropped its snapshot\n' "$name"
    ;;
  list)
    [ -s "$AUTH" ] || { printf 'no clients authorised\n'; exit 0; }
    while read -r line; do
      case "$line" in ''|\#*) continue ;; esac
      name=$(printf '%s' "$line" | sed -n 's/.*ingest \([a-z0-9_-]*\)".*/\1/p')
      snap="${SNAPSHOTS}/${name}.json"
      if [ -f "$snap" ]; then
        age=$(( $(date +%s) - $(stat -c %Y "$snap") ))
        printf '%-20s last snapshot %ss ago\n' "$name" "$age"
      else
        printf '%-20s no snapshot yet\n' "$name"
      fi
    done < "$AUTH"
    ;;
  *) usage ;;
esac
