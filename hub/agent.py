#!/usr/bin/env python3
"""Collects one snapshot of this server and pushes it to the hub. Run by a systemd timer.

Push, not pull: the hub never opens a connection to a watched server, so watching a machine
costs it no inbound port and no extra key on its side. The one direction that exists is this
one, and on the hub it lands in a forced command that can do nothing but store a snapshot.

Everything here is read-only and cheap — /proc, df, docker ps, one local HTTP request. The
timer runs once a minute, so nothing may block for long: every external call has a timeout,
and a section that cannot be collected becomes null rather than failing the whole snapshot.

Python 3 standard library only, so a watched server needs nothing installed.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONFIG = "/etc/shipkit-agent/agent.env"
SCHEMA = 1


def log(msg):
    sys.stderr.write("shipkit-agent: %s\n" % msg)


def config():
    """agent.env is a systemd EnvironmentFile, so it is already in the environment here.

    Reading the file as well lets the agent be run by hand for diagnosis without exporting
    eight variables first.
    """
    values = {}
    try:
        with open(CONFIG) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    except OSError:
        pass
    values.update({k: v for k, v in os.environ.items() if k.startswith("SHIPKIT_")})
    return values


def run(argv, timeout=10):
    try:
        out = subprocess.run(argv, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.decode("utf-8", "replace")


def collect_load():
    try:
        with open("/proc/loadavg") as fh:
            one, five, fifteen = fh.read().split()[:3]
        return {"1": float(one), "5": float(five), "15": float(fifteen)}
    except (OSError, ValueError):
        return None


def collect_memory():
    wanted = {"MemTotal": "total_kb", "MemAvailable": "available_kb"}
    mem = {}
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                if key in wanted:
                    mem[wanted[key]] = int(rest.split()[0])
    except (OSError, ValueError, IndexError):
        return None
    return mem or None


def collect_disks():
    out = run(["df", "-h", "--output=target,size,used,pcent", "-x", "tmpfs", "-x", "devtmpfs", "-x", "overlay"])
    if not out:
        return None
    disks = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) != 4:
            continue
        disks.append(
            {"mount": parts[0], "size": parts[1], "used": parts[2], "use_percent": parts[3].rstrip("%")}
        )
    return disks


def collect_containers():
    # Every container, not just the running ones: a container that exited is the thing worth
    # seeing, and `docker ps` alone would show an empty list for a box whose app has crashed.
    out = run(["docker", "ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"], timeout=15)
    if out is None:
        return None
    containers = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            containers.append({"name": parts[0], "state": parts[1], "status": parts[2]})
    return containers


def collect_app(cfg):
    url = cfg.get("SHIPKIT_HEALTH_URL")
    if not url:
        return None
    app = {"service": cfg.get("SHIPKIT_SERVICE") or "app", "url": url, "ok": False, "version": None, "error": None}
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            body = resp.read(64 * 1024).decode("utf-8", "replace")
            status = resp.status
    except (urllib.error.URLError, OSError, ValueError) as exc:
        app["error"] = "%s: %s" % (type(exc).__name__, exc)
        return app
    # The same shape the deploy gate reads (.dagger/src/core/health.ts): a JSON body with a
    # `version`. Anything else is reported as no version rather than guessed at.
    try:
        parsed = json.loads(body)
        version = parsed.get("version") or parsed.get("Version")
    except (ValueError, AttributeError):
        version = None
    app["ok"] = status == 200 and bool(version)
    app["version"] = version if isinstance(version, str) and version else None
    if status != 200:
        app["error"] = "HTTP %s" % status
    elif not version:
        app["error"] = "no version in the health response"
    return app


def collect_deploys(cfg):
    """The tail of Kamal's audit log, which is the only record on the box of what was released.

    Kamal's path has moved between versions, so the newest *audit*.log anywhere under the
    deploy user's ~/.kamal is used rather than one hard-coded path.
    """
    home = os.path.expanduser("~" + (cfg.get("SHIPKIT_DEPLOY_USER") or "deploy"))
    root = os.path.join(home, ".kamal")
    if not os.path.isdir(root):
        return None
    newest, newest_mtime = None, -1
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if "audit" not in name or not name.endswith(".log"):
                continue
            path = os.path.join(dirpath, name)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if mtime > newest_mtime:
                newest, newest_mtime = path, mtime
    if not newest:
        return None
    lines = int(cfg.get("SHIPKIT_DEPLOY_LINES") or 6)
    try:
        with open(newest, errors="replace") as fh:
            return [line.rstrip("\n") for line in fh.readlines()[-lines:]]
    except OSError:
        return None


def collect_backups(cfg):
    root = cfg.get("SHIPKIT_BACKUP_ROOT") or "/var/backups/shipkit"
    if not os.path.isdir(root):
        return None
    now = time.time()
    entries = []
    for service in sorted(os.listdir(root)):
        directory = os.path.join(root, service)
        if not os.path.isdir(directory):
            continue
        entry = {"service": service, "dir": directory, "newest": None, "age_seconds": None, "size_bytes": None}
        newest, newest_mtime = None, -1
        for name in os.listdir(directory):
            path = os.path.join(directory, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if stat.st_mtime > newest_mtime:
                newest, newest_mtime = (name, stat.st_size), stat.st_mtime
        if newest:
            entry["newest"] = newest[0]
            entry["size_bytes"] = newest[1]
            entry["age_seconds"] = int(now - newest_mtime)
        entries.append(entry)
    return entries


def snapshot(cfg):
    with open("/proc/uptime") as fh:
        uptime = int(float(fh.read().split()[0]))
    return {
        "schema": SCHEMA,
        "collected_at": int(time.time()),
        "hostname": os.uname().nodename,
        "uptime_seconds": uptime,
        "cpus": os.cpu_count(),
        "load": collect_load(),
        "memory": collect_memory(),
        "disks": collect_disks(),
        "containers": collect_containers(),
        "app": collect_app(cfg),
        "deploys": collect_deploys(cfg),
        "backups": collect_backups(cfg),
    }


def push(cfg, payload):
    key = cfg.get("SHIPKIT_AGENT_KEY") or "/etc/shipkit-agent/id_ed25519"
    known_hosts = cfg.get("SHIPKIT_AGENT_KNOWN_HOSTS") or "/etc/shipkit-agent/known_hosts"
    argv = [
        "ssh", "-T", "-i", key,
        # The hub's key is pinned at install time. An unknown key here means something is
        # answering for the hub that is not the hub, and the snapshot is not for it.
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=%s" % known_hosts,
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "%s@%s" % (cfg.get("SHIPKIT_HUB_USER") or "shipkit-hub", cfg["SHIPKIT_HUB_HOST"]),
    ]
    try:
        out = subprocess.run(argv, input=payload.encode("utf-8"), capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log("push did not complete: %s" % type(exc).__name__)
        return 3
    if out.returncode != 0:
        log("push failed (exit %d): %s" % (out.returncode, out.stderr.decode("utf-8", "replace").strip()))
        return 3
    return 0


def main():
    cfg = config()
    if not cfg.get("SHIPKIT_HUB_HOST"):
        log("SHIPKIT_HUB_HOST is not set; see %s" % CONFIG)
        return 2
    payload = json.dumps(snapshot(cfg), separators=(",", ":"))
    if "--dry-run" in sys.argv:
        sys.stdout.write(payload + "\n")
        return 0
    return push(cfg, payload)


if __name__ == "__main__":
    sys.exit(main())
