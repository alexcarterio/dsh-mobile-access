# dsh-push

Forward DeepSeek Harness (DSH) session events to your phone via
[ntfy](https://ntfy.sh): a high-priority notification when DSH is waiting for
your approval or a reply, and a normal notification when a work turn finishes.

This directory is the home of the phone push watcher for the dsh-mobile-access
kit. It is fully self-contained: everything it needs lives in this repository.

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

## Keep it running (Windows autostart)

`start_push.bat` flashes a console window when launched from Task Scheduler,
and the `pyw -3` launcher may be missing from the scheduler's PATH. For a
windowless, self-restarting watcher, register a **hidden** task that runs
`pythonw.exe` directly (no cmd shim, so nothing can flash):

```powershell
$py     = (Get-Command pythonw.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot "dsh_push.py"
$action   = New-ScheduledTaskAction -Execute $py -Argument ('"' + $script + '"')
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "DSH Phone Push" -Action $action -Trigger $trigger -Settings $settings -Force
```

The watcher holds a single-instance lock, so the every-minute trigger simply
revives it whenever it dies; no duplicate processes accumulate.
