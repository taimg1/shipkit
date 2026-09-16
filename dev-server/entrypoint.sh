#!/bin/sh
# Start the Docker daemon, then hold the container open with sshd.
set -e

# The authorized key is mounted in; copy rather than symlink so sshd's permission checks pass.
if [ -f /keys/authorized_keys ]; then
  cp /keys/authorized_keys /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
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

# dockerd creates its socket owned by the docker group only if that group existed when it
# started; make sure the deploy user can reach it either way.
chgrp docker /var/run/docker.sock && chmod 660 /var/run/docker.sock

echo "docker is up; starting sshd"
exec /usr/sbin/sshd -D -e
