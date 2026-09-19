#!/usr/bin/env bash
# Move a locally built image into the dev server's registry.
#
# In production `ci` pushes to GHCR and Kamal pulls from there. Locally there is no
# credentialled registry and Dagger will not talk HTTP to one, so the image goes in the back
# way: saved on the host, loaded on the server, pushed from there to the registry the server
# already trusts.
#
# This is simulation scaffolding. Nothing in the kit depends on it.
set -euo pipefail

IMAGE="${1:?usage: load-image.sh <local-image> <target-tag>}"
TAG="${2:?usage: load-image.sh <local-image> <target-tag>}"
TARGET="registry:5000/shipkit-fixture:${TAG}"

here="$(cd "$(dirname "$0")" && pwd)"
# The server's key is fixed (host-key/), so it is pinned here too rather than waved through.
known_hosts="$(mktemp)"
trap 'rm -f "$known_hosts"' EXIT
printf '[localhost]:2222 %s\n' "$(cut -d' ' -f1,2 "$here/host-key/ssh_host_ed25519_key.pub")" > "$known_hosts"
ssh_opts=(-i "$here/.ssh/id_ed25519" -p 2222
          -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o LogLevel=ERROR)

echo "saving $IMAGE and loading it on the server..."
docker save "$IMAGE" | ssh "${ssh_opts[@]}" deploy@localhost "docker load"

echo "pushing $TARGET from the server..."
ssh "${ssh_opts[@]}" deploy@localhost \
  "docker tag '$IMAGE' '$TARGET' && docker push '$TARGET'" >/dev/null

echo "in the registry: $TARGET"
