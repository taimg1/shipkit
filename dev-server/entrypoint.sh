#!/bin/sh
# Start the Docker daemon, then hold the container open with sshd.
set -e

# The authorized key is mounted in; copy rather than symlink so sshd's permission checks pass.
if [ -f /keys/authorized_keys ]; then
  cp /keys/authorized_keys /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi

# dind's own entrypoint starts dockerd and daemonises nothing, so run it in the background
# and wait for the socket before letting anything connect.
dockerd-entrypoint.sh "$@" >/var/log/dockerd.log 2>&1 &

for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 1
done

if ! docker info >/dev/null 2>&1; then
  echo "dockerd did not come up; last lines of its log:" >&2
  tail -20 /var/log/dockerd.log >&2
  exit 1
fi

echo "docker is up; starting sshd"
exec /usr/sbin/sshd -D -e
