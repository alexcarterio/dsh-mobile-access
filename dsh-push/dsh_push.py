# -*- coding: utf-8 -*-
"""
DSH phone push notifications — forward DSH session events to your phone via ntfy.

Reuses the event folding from dsh_watch.DshWatch (read-only access to session
logs, no DSH intrusion):
  waiting_user -> approval / question waiting for the user -> high priority
  turn_done    -> one task turn completed                -> normal priority

Usage:
  py dsh_push.py            # run continuously and push events
  py dsh_push.py --test     # send a test notification immediately (verify channel)

Configuration (optional environment variables; safe defaults built in):
  NTFY_URL    push server, defaults to https://ntfy.sh
  NTFY_TOPIC  topic name (set YOUR topic below; a topic acts like a secret, do not leak it)
  NTFY_TOKEN  optional: ntfy account access token
"""
import os
import sys
import time
import urllib.parse

import requests

from dsh_watch import DshWatch, EVENT_TURN_DONE, EVENT_WAITING_USER

NTFY_URL = os.environ.get("NTFY_URL", "https://ntfy.sh")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "YOUR_NTFY_TOPIC")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
# Note: no Click header is sent (the WebAPK App Links for a Tailscale domain
# cannot be verified; tapping would only open a browser). Notifications are
# reminders only, and tapping expands the details.
POLL_SECONDS = 2

_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dsh_push.log")


def log(msg):
    """Append to the log file (pythonw has no stdout; print would crash, so no print)."""
    try:
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + str(msg) + "\n")
    except Exception:
        pass


def push(title, message, priority=3, tags="", sound=None):
    url = f"{NTFY_URL}/{urllib.parse.quote(NTFY_TOPIC, safe='')}"
    headers = {
        # UTF-8 title as bytes: the ntfy server decodes it as UTF-8, avoiding mojibake
        "Title": title.encode("utf-8"),
        "Priority": str(priority),
    }
    if tags:
        headers["Tags"] = tags
    if sound:
        # Do not force a sound name by default: let the app use the system
        # default notification sound (most reliable across versions). To
        # customize, pass a built-in ntfy sound name (e.g. "echo") at the call site.
        headers["X-Sound"] = sound
    if NTFY_TOKEN:
        headers["Authorization"] = "Bearer " + NTFY_TOKEN
    try:
        resp = requests.post(url, data=message.encode("utf-8"),
                             headers=headers, timeout=10)
        return resp.status_code
    except Exception as e:
        log(f"push failed: {e}")
        return None


def main():
    if "--test" in sys.argv:
        status = push("✅ Channel test", "DSH phone push channel is working!",
                      priority=5, tags="whale")
        print(f"[dsh_push] test push status: {status}", flush=True)
        return

    lock = acquire_single_instance()
    if lock is None:
        return  # an instance is already running (the daemon retries every minute)

    watch = DshWatch()
    log(f"started watching DSH sessions (topic={NTFY_TOPIC})")

    def on_event(ev):
        t = ev.get("type")
        sess = ev.get("title") or "Untitled session"
        if t == EVENT_WAITING_USER:
            kind = ev.get("kind")
            tool = ev.get("tool") or ""
            if kind == "approval":
                if tool:
                    push("⏳ DSH needs approval", f"'{sess}' requested to run '{tool}', waiting for your approval",
                         priority=5, tags="warning")
                else:
                    push("⏳ DSH needs approval", f"'{sess}' has an action waiting for your approval",
                         priority=5, tags="warning")
            else:
                push("❓ DSH is waiting for you", f"'{sess}' asked you a question, waiting for your reply",
                     priority=5, tags="question")
        elif t == EVENT_TURN_DONE:
            push("✅ DSH task complete", f"'{sess}' finished a task turn",
                 priority=4, tags="check")

    watch.on_event = on_event
    while True:
        try:
            watch.poll()
        except Exception as e:
            log(f"poll error: {e}")
        time.sleep(POLL_SECONDS)


def acquire_single_instance():
    """Single-instance lock: failing to bind a fixed port means an instance is
    already running (the daemon retries every minute)."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 27999))
        s.listen(1)
        return s
    except OSError:
        return None


if __name__ == "__main__":
    main()
