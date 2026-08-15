# dsh-push

Forward DeepSeek Harness (DSH) session events to your phone via
[ntfy](https://ntfy.sh): a high-priority notification when DSH is waiting for
your approval or a reply, and a normal notification when a work turn finishes.

This watcher was originally part of the
[deepseek-whale-pet](https://github.com/alexcarterio/deepseek-whale-pet)
desktop pet project and is now maintained here, next to the rest of the phone
access kit. The pet repository remains the canonical home of the shared
`dsh_watch.py` session monitor; the copy in this directory is a mirror — changes
to `dsh_watch.py` should be made in the pet repository and mirrored here.

## Privacy

- **Session titles are included in the notification body** and are sent to the
  ntfy server (`https://ntfy.sh` by default). If that matters to you, self-host
  ntfy and set `NTFY_URL` to your own server.
- A topic name acts like a password: anyone who knows it can read your
  notifications. Pick a long, random value and never publish it.
- Only the main DSH session is watched; subagent sessions are filtered out.

## Setup

```text
pip install requests zstandard
```

| Environment variable | Description |
|---|---|
| `NTFY_URL` | Push server, default `https://ntfy.sh` (self-hosting supported). |
| `NTFY_TOPIC` | **Required.** Your topic name — treat it like a secret. |
| `NTFY_TOKEN` | Optional ntfy account access token. |
| `NTFY_CLICK` | Optional URL opened when a notification is tapped. |

Run:

```text
py dsh_push.py            # watch continuously and push
py dsh_push.py --test     # send one test notification right now
```

Or start it as a background process on Windows with `start_push.bat`
(uses `%~dp0`, so it works from any location).

Subscribe your phone by opening `https://ntfy.sh/<your-topic>` in the ntfy app.
