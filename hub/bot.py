#!/usr/bin/env python3
"""The Telegram side of the hub: answers four commands, and says when a server goes quiet.

Long polling, so the hub needs no inbound port, no domain and no certificate — every
connection is outbound to api.telegram.org. That is also why the bot is on the hub and the
hub is not one of the watched machines.

The token and the chat id come from the environment. systemd reads them out of
/etc/shipkit-hub/telegram.env as root and hands them over, so the file stays 0600 root and
this process never has permission to open it. Neither value is ever logged.

Python 3 standard library only.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import statuslib  # noqa: E402

SNAPSHOT_DIR = os.environ.get("SHIPKIT_HUB_SNAPSHOTS", "/var/lib/shipkit-hub/snapshots")
STATE_DIR = os.environ.get("SHIPKIT_HUB_STATE", "/var/lib/shipkit-hub/state")

# getUpdates blocks for this long when nothing is happening, which doubles as the tick of the
# silence check: the loop comes round at least this often without polling in a busy circle.
POLL_SECONDS = 25


def log(msg):
    sys.stderr.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg))
    sys.stderr.flush()


class Telegram:
    def __init__(self, token, chat_id):
        self._base = "https://api.telegram.org/bot%s/" % token
        self.chat_id = chat_id

    def call(self, method, params, timeout):
        data = urllib.parse.urlencode(params).encode("utf-8")
        req = urllib.request.Request(self._base + method, data=data)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        if not body.get("ok"):
            # The token is in the URL, so the URL never goes into the message.
            raise RuntimeError("telegram %s failed: %s" % (method, body.get("description")))
        return body["result"]

    def updates(self, offset):
        return self.call("getUpdates", {"offset": offset, "timeout": POLL_SECONDS}, POLL_SECONDS + 15)

    def send(self, text):
        # A fenced block keeps the columns lined up; inside one, MarkdownV2 only gives meaning
        # to a backslash and a backtick, so that is the whole escape.
        fenced = "```\n%s\n```" % text.replace("\\", "\\\\").replace("`", "\\`")
        result = self.call("sendMessage", {"chat_id": self.chat_id, "text": fenced, "parse_mode": "MarkdownV2"}, 30)
        # Logged because it is the only evidence from outside the chat that a message landed
        # in it: Telegram has no way to read back what a bot sent.
        return result.get("message_id")


def read_snapshots():
    snaps = {}
    try:
        names = os.listdir(SNAPSHOT_DIR)
    except OSError:
        return snaps
    for name in names:
        if not name.endswith(".json") or name.startswith("."):
            continue
        try:
            with open(os.path.join(SNAPSHOT_DIR, name)) as fh:
                snap = json.load(fh)
        except (OSError, ValueError):
            continue
        # The filename is written by the ingest command from the key that pushed; the `server`
        # field was set from the same place. Trusting the filename keeps one source.
        snaps[name[: -len(".json")]] = snap
    return snaps


def load_state(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, path)


def main():
    # TELEGRAM_BOT_TOKEN is the name already in /etc/shipkit-hub/telegram.env on the hub;
    # the shorter name is accepted too so that a file written the other way still works.
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or os.environ.get("TELEGRAM_TOKEN") or "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        log("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing from the environment")
        return 2
    if chat_id != str(statuslib.ALLOWED_CHAT_ID):
        log("refusing to run: configured chat id is not the one this hub answers")
        return 2

    os.makedirs(STATE_DIR, exist_ok=True)
    offset_path = os.path.join(STATE_DIR, "offset")
    silence_path = os.path.join(STATE_DIR, "silence.json")

    tg = Telegram(token, chat_id)
    offset = load_state(offset_path).get("offset", 0) if os.path.exists(offset_path) else 0
    silence = load_state(silence_path)
    log("started; watching %s" % SNAPSHOT_DIR)

    while True:
        try:
            for update in tg.updates(offset):
                offset = max(offset, update["update_id"] + 1)
                save_state(offset_path, {"offset": offset})
                message = update.get("message") or update.get("edited_message") or {}
                # Anyone else gets nothing at all — not a refusal, which would confirm the bot
                # exists and invite another try.
                if str((message.get("chat") or {}).get("id")) != chat_id:
                    continue
                parsed = statuslib.parse_command(message.get("text"))
                if not parsed:
                    continue
                reply = statuslib.answer(parsed[0], parsed[1], read_snapshots(), time.time())
                if reply:
                    log("/%s %s -> message %s" % (parsed[0], parsed[1] or "", tg.send(reply)))

            silence, messages = statuslib.silence_events(silence, read_snapshots(), time.time())
            for text in messages:
                # The whole alert, not just its verb: when someone asks later whether an alert
                # was sent and what it said, the journal is the only place that can answer.
                log("alert -> message %s: %s" % (tg.send(text), text))
            save_state(silence_path, silence)
        except (urllib.error.URLError, OSError, RuntimeError, ValueError) as exc:
            # Telegram goes away, DNS blips, the box sleeps. None of that is worth dying over;
            # systemd would only restart into the same condition a second later.
            log("retrying after error: %s" % type(exc).__name__)
            time.sleep(10)


if __name__ == "__main__":
    sys.exit(main())
