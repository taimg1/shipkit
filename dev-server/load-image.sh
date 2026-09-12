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
ssh_opts=(-i "$here/.ssh/id_ed25519" -p 2222
          -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

echo "saving $IMAGE and loading it on the server..."
docker save "$IMAGE" | ssh "${ssh_opts[@]}" root@localhost "docker load"

echo "pushing $TARGET from the server..."
ssh "${ssh_opts[@]}" root@localhost \
  "docker tag '$IMAGE' '$TARGET' && docker push '$TARGET'" >/dev/null

echo "in the registry: $TARGET"
