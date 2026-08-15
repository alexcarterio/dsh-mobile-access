# Android User Guide

> For using an Android phone to reach DeepSeek Harness (DSH) on your computer
> remotely. The only difference from the iOS guide is step 4 (installing to the
> home screen); everything else is identical.

## 1. Preparation (install two apps)

1. **Tailscale** — install from the Play Store (or the official APK), then sign
   in with the **same account** used on the computer.
2. **ntfy** (optional, for push notifications) — install from the Play Store.

## 2. Step 1: Connect Tailscale

1. Open the Tailscale app and flip the top switch on; the status should show
   **Connected**.
2. Keep Tailscale alive in the background: allow auto-start and disable battery
   optimization for the app (on HyperOS/MIUI also enable "Autostart" and set
   battery to "No restrictions", and lock the app in the recent-tasks list).

## 3. Step 2: Open the DSH entry (first access needs approval)

Use either entry; the HTTPS one is recommended:

```text
https://<your-device>.your-tailnet.ts.net:3443   (recommended, valid certificate)
http://<machine-tailscale-ip>:3088               (device-approval gate, plain HTTP)
```

1. The first visit shows a "Waiting for approval on this machine" page — this is
   the security gate working as intended.
2. **On the computer**: DSH Settings → LAN Access → pending device → choose
   access mode **Phone** → **Allow**.
3. The phone then drops straight into the DSH UI.

## 4. Step 3: Install to the home screen (full-screen PWA)

1. In Chrome, open the **HTTPS 3443 address** (Chrome only offers the install
   entry on a secure context).
2. Tap **⋮** (top right) → **Install app / Add to Home screen**.
3. Confirm and install; a DSH icon appears on the home screen.
4. Tapping the icon opens the **full-screen app** (no browser address bar).

> With the plain-HTTP 3088 address Chrome only offers a normal shortcut, not
> the install flow — use the HTTPS address for the real app experience.

## 5. Step 4: Push notifications (optional)

1. Open the ntfy app.
2. Tap **+** → add a subscription, and enter the topic:

   ```text
   <your-ntfy-topic>
   ```

   (The topic is configured by the `dsh-push` watcher on the computer; treat it
   like a secret.)

3. Allow notifications when Android asks on first subscribe.
4. Tapping a notification opens ntfy to read the message.

> On HyperOS/MIUI also allow auto-start and disable battery optimization for
> ntfy, otherwise push may be delayed or dropped.

## 6. Daily use

- **Send messages**: same as the web UI — type in the input box and send.
- **Send images**: use the floating 🖼 / 📷 buttons at the bottom right (they
  reuse the desktop paste path; the first camera/gallery launch has a cold-start
  delay).
- **Switch sessions / workspaces**: left sidebar, same as on desktop.
- **Reopen later**: tap the DSH icon; if it shows disconnected, first confirm
  Tailscale is Connected.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Page does not open / keeps spinning | Confirm the Tailscale app shows Connected; disconnect and reconnect once, then retry |
| The approval page appears again | On the computer panel confirm the device is Allowed; if it is not listed, reload the page once |
| 429 "Too many requests" | Per-IP rate limit (3000/min) hit; wait a minute |
| No push notifications | In ntfy confirm the subscription exists and battery optimization is disabled for it |
| No "Install app" entry in Chrome | Use the HTTPS (Tailscale Serve) address; refresh once so the manifest loads |

## 8. Security notes

- All access runs inside the Tailscale encrypted tunnel (HTTPS on the Serve
  entry); only devices under your account can reach it.
- Unapproved devices cannot enter; approval records can be revoked from the
  LAN Access panel on the computer.
- New phone: install Tailscale and sign in with the same account → open the
  entry address → approve the new device on the computer panel → re-add to the
  home screen.
