#!/usr/bin/env python3
"""The forced command behind every client key. It accepts a snapshot on stdin and nothing else.

sshd runs this as `ingest.py <client>` because the authorized_keys line says so:

    command="/usr/local/lib/shipkit-hub/ingest <client>",restrict ssh-ed25519 AAAA... <client>

The client name is that argument. It is never read from the payload: a client that puts
another server's name in its own JSON gets that field overwritten (statuslib.normalise), so
a stolen key can only overwrite the snapshot of the server it was issued to.

SSH_ORIGINAL_COMMAND — whatever the client asked to run — is deliberately not read at all.
There is nothing a client could put there that this program would act on.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import statuslib  # noqa: E402

SNAPSHOT_DIR = os.environ.get("SHIPKIT_HUB_SNAPSHOTS", "/var/lib/shipkit-hub/snapshots")


def main(argv):
    client = argv[1] if len(argv) > 1 else ""
    try:
        raw = sys.stdin.buffer.read(statuslib.MAX_SNAPSHOT_BYTES + 1)
        snap = statuslib.normalise(raw, client)
    except statuslib.Rejected as exc:
        sys.stderr.write("shipkit-hub: rejected: %s\n" % exc)
        return 1

    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    target = os.path.join(SNAPSHOT_DIR, client + ".json")
    # Written to a temporary file and renamed, so the bot never reads half a snapshot.
    fd, tmp = tempfile.mkstemp(dir=SNAPSHOT_DIR, prefix=".%s." % client)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(snap, fh)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except BaseException:
        os.unlink(tmp)
        raise
    sys.stdout.write("stored %s\n" % client)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
