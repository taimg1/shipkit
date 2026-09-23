"""Everything the hub decides, with no I/O in it.

The bot and the ingest command are thin shells around this module: one talks to Telegram,
the other to sshd, and neither is reachable from a test. The rules that can be wrong —
which payload is acceptable, when a server counts as silent, what an answer says — live
here, where tests/status-hub.test.ts can run them.

Python 3 standard library only (README of hub/): nothing is installed on a watched server.
"""

import json
import re
import time

# A snapshot arrives once a minute. Three minutes is two missed pushes plus slack for a slow
# one, which is late enough not to fire on an agent that ran a second behind schedule.
SILENCE_AFTER = 180

# The payload is untrusted input from a machine that may be compromised. It is read into
# memory whole, so it is capped rather than streamed.
MAX_SNAPSHOT_BYTES = 64 * 1024

# One authorized_keys line per client, and this is the name in it. It ends up in a file path,
# so it may not contain a separator or a dot-dot.
CLIENT_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,62}\Z")

ALLOWED_CHAT_ID = 882364515


class Rejected(Exception):
    """A payload the hub refuses to store."""


def valid_client(name):
    return bool(name) and bool(CLIENT_NAME.match(name))


def normalise(raw, client, now=None):
    """Turn what arrived on stdin into what gets stored, or refuse it.

    `client` comes from the forced command in authorized_keys — from which key signed the
    session, never from the payload. A client that names another server in its own JSON has
    that field overwritten here, which is the whole reason the field is set rather than read.
    """
    if not valid_client(client):
        raise Rejected("client name %r is not a valid name" % (client,))
    if len(raw) > MAX_SNAPSHOT_BYTES:
        raise Rejected("snapshot is larger than %d bytes" % MAX_SNAPSHOT_BYTES)
    try:
        snap = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
    except (UnicodeDecodeError, ValueError) as exc:
        raise Rejected("snapshot is not JSON: %s" % exc)
    if not isinstance(snap, dict):
        raise Rejected("snapshot is not a JSON object")
    snap["server"] = client
    snap["received_at"] = int(now if now is not None else time.time())
    return snap


def age_seconds(snap, now):
    """How long ago the hub received this snapshot.

    Measured against the hub's own clock at receipt, not the client's `collected_at`: a
    client with a wrong clock would otherwise look silent, or look fresh forever.
    """
    return max(0, int(now) - int(snap.get("received_at", 0)))


def is_silent(snap, now, threshold=SILENCE_AFTER):
    return age_seconds(snap, now) > threshold


def human_age(seconds):
    seconds = int(seconds)
    if seconds < 60:
        return "%ds" % seconds
    if seconds < 3600:
        return "%dm" % (seconds // 60)
    if seconds < 86400:
        return "%dh %dm" % (seconds // 3600, (seconds % 3600) // 60)
    return "%dd %dh" % (seconds // 86400, (seconds % 86400) // 3600)


def human_bytes(n):
    if n is None:
        return "?"
    units = ["B", "K", "M", "G", "T"]
    size = float(n)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return "%.0f%s" % (size, unit) if unit == "B" else "%.1f%s" % (size, unit)
        size /= 1024


def silence_events(state, snaps, now, threshold=SILENCE_AFTER):
    """Decide which alerts to send, given what was already sent.

    Returns (new_state, messages). The state is the memory that keeps this to one alert per
    transition instead of one per tick: a server that has been silent for an hour is still
    one message, and the recovery is the second.
    """
    new_state = {}
    messages = []
    for name in sorted(snaps):
        silent = is_silent(snaps[name], now, threshold)
        was_silent = bool(state.get(name))
        new_state[name] = silent
        if silent and not was_silent:
            messages.append(
                "SILENT: %s has not pushed for %s (was %s)."
                % (name, human_age(age_seconds(snaps[name], now)), _served_version(snaps[name]))
            )
        elif was_silent and not silent:
            messages.append("BACK: %s is pushing again." % name)
    # A server that was disconnected stops being tracked rather than staying silent forever.
    return new_state, messages


def _served_version(snap):
    app = snap.get("app") or {}
    return app.get("version") or "version unknown"


def parse_command(text):
    """Split a Telegram message into (command, argument), or None if it is not a command.

    Telegram appends @botname when several bots share a group, so the suffix is stripped.
    """
    if not isinstance(text, str):
        return None
    parts = text.strip().split()
    if not parts or not parts[0].startswith("/"):
        return None
    cmd = parts[0][1:].split("@", 1)[0].lower()
    if not cmd:
        return None
    return cmd, (parts[1] if len(parts) > 1 else None)


def format_status(snaps, now, threshold=SILENCE_AFTER):
    if not snaps:
        return "No server has ever pushed a snapshot. See docs/runbooks/status-hub.md."
    lines = ["status  %s UTC" % time.strftime("%Y-%m-%d %H:%M", time.gmtime(now)), ""]
    width = max(len(n) for n in snaps)
    for name in sorted(snaps):
        snap = snaps[name]
        state = "SILENT" if is_silent(snap, now, threshold) else "alive"
        lines.append(
            "%-*s  %-6s  %6s ago  %s"
            % (width, name, state, human_age(age_seconds(snap, now)), _served_version(snap))
        )
    return "\n".join(lines)


def _header(name, snap, now):
    return "%s  (snapshot %s ago)" % (name, human_age(age_seconds(snap, now)))


def format_load(name, snap, now):
    lines = [_header(name, snap, now), ""]
    load = snap.get("load") or {}
    cpus = snap.get("cpus")
    if load:
        lines.append(
            "load   %.2f %.2f %.2f   over %s CPU%s"
            % (load.get("1", 0), load.get("5", 0), load.get("15", 0), cpus or "?", "" if cpus == 1 else "s")
        )
    mem = snap.get("memory") or {}
    if mem.get("total_kb"):
        used = mem["total_kb"] - mem.get("available_kb", 0)
        lines.append(
            "memory %s / %s used (%d%%)"
            % (human_bytes(used * 1024), human_bytes(mem["total_kb"] * 1024), 100 * used // mem["total_kb"])
        )
    for disk in snap.get("disks") or []:
        lines.append(
            "disk   %-12s %s / %s used (%s%%)"
            % (disk.get("mount", "?"), disk.get("used", "?"), disk.get("size", "?"), disk.get("use_percent", "?"))
        )
    app = snap.get("app") or {}
    if app.get("url"):
        lines.append("")
        if app.get("ok"):
            lines.append("health %s -> %s" % (app["url"], app.get("version") or "no version in response"))
        else:
            lines.append("health %s -> FAILED: %s" % (app["url"], app.get("error") or "unknown"))
    containers = snap.get("containers")
    lines.append("")
    if containers:
        lines.append("containers")
        for c in containers:
            lines.append("  %-28s %-9s %s" % (c.get("name", "?"), c.get("state", "?"), c.get("status", "")))
    else:
        lines.append("containers: none running")
    return "\n".join(lines)


def format_deploys(name, snap, now):
    lines = [_header(name, snap, now), ""]
    deploys = snap.get("deploys")
    if deploys is None:
        lines.append("No Kamal audit log on this server — nothing has been deployed here yet.")
    elif not deploys:
        lines.append("The Kamal audit log is empty.")
    else:
        lines.append("last %d entries of the Kamal audit log:" % len(deploys))
        lines.extend("  " + line for line in deploys)
    return "\n".join(lines)


def format_backups(name, snap, now):
    lines = [_header(name, snap, now), ""]
    backups = snap.get("backups")
    # None and [] mean different things and a reader acts on them differently: no directory
    # at all is a server that was never set up to dump, an empty one is a dump that stopped.
    if backups is None:
        lines.append("No dump directory on this server (/var/backups/shipkit/<service>/).")
        return "\n".join(lines)
    if not backups:
        lines.append("The dump directory exists but holds no service: nothing has ever dumped here.")
        return "\n".join(lines)
    for entry in backups:
        if not entry.get("newest"):
            lines.append("%s: no dump in %s" % (entry.get("service", "?"), entry.get("dir", "?")))
            continue
        lines.append(
            "%s: %s  %s  %s old"
            % (
                entry.get("service", "?"),
                entry["newest"],
                human_bytes(entry.get("size_bytes")),
                human_age(entry.get("age_seconds", 0)),
            )
        )
    return "\n".join(lines)


def answer(command, argument, snaps, now, threshold=SILENCE_AFTER):
    """The reply to one command, or None when the bot should stay quiet."""
    if command == "status":
        return format_status(snaps, now, threshold)
    formatters = {"load": format_load, "deploys": format_deploys, "backups": format_backups}
    if command not in formatters:
        return "Commands: /status, /load <server>, /deploys <server>, /backups <server>"
    if not argument:
        return "Which server? %s" % (", ".join(sorted(snaps)) or "none connected")
    if argument not in snaps:
        return "No server called %s. Known: %s" % (argument, ", ".join(sorted(snaps)) or "none")
    return formatters[command](argument, snaps[argument], now)
