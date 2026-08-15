# iOS User Guide (iPhone / iPad)

> For using an iPhone or iPad to reach DeepSeek Harness (DSH) on your computer
> remotely. The only difference from the Android guide is step 4 (installing to
> the home screen); everything else is identical.
> iOS 16 or later is recommended (16.4+ fully supports standalone PWA mode).

## 1. Preparation (install two apps from the App Store)

1. **Tailscale** — search and install, then sign in with the **same account**
   used on the computer.
2. **ntfy** (optional, for push notifications) — search and install.

## 2. Step 1: Connect Tailscale

1. Open the Tailscale app and flip the top switch on; the status should show
   **Connected**.
2. Recommended: enable the on-demand VPN connection so the tunnel survives
   screen lock (Settings → VPN → On-Demand).
3. Recommended: allow background refresh for Tailscale in iOS Settings.

## 3. Step 2: Open the DSH entry (first access needs approval)

1. Open this address in Safari:

   ```text
   https://<your-device>.your-tailnet.ts.net:3443
   ```

   (The address is provided by `tailscale serve` on the computer; the
   certificate is publicly trusted, so it opens without warnings.)

2. The first visit shows a "Waiting for approval on this machine" page — this is
   the security gate working as intended.
3. **On the computer**: DSH Settings → LAN Access → pending device → choose
   access mode **Phone** → **Allow**.
4. The phone then drops straight into the DSH UI.

## 4. Step 3: Install to the home screen (full-screen PWA)

1. In Safari, open the 3443 address above (after approval).
2. Tap the **Share button** (square with an up arrow) → **Add to Home Screen**.
3. Confirm the name (e.g. DSH) → tap **Add**. A DSH icon appears on the home
   screen.
4. Tapping the icon opens the **full-screen app** (no browser address bar).

> Unlike Android, iOS has no "Install app" menu item — "Share → Add to Home
> Screen" achieves the same result.

## 5. Step 4: Push notifications (optional)

1. Open the ntfy app.
2. Tap **+** (bottom right) → add a subscription, and enter the topic:

   ```text
   <your-ntfy-topic>
   ```

   (The topic is configured by the `dsh-push` watcher on the computer; treat it
   like a secret.)

3. iOS asks for notification permission on first subscribe — choose **Allow**.
4. Tapping a notification opens ntfy to read the message; to jump into DSH,
   tap the DSH home-screen icon.

> The ntfy free tier has a daily push quota for iOS (roughly 250 messages),
> which is plenty for normal use.

## 6. Daily use

- **Send messages**: same as the web UI — type in the input box and send.
- **Send images**: use the attachment menu next to the input box → take a photo
  or pick from the gallery (natively supported in iOS Safari).
- **Switch sessions / workspaces**: left sidebar, same as on desktop.
- **Reopen later**: tap the DSH icon; if it shows disconnected, first confirm
  Tailscale is Connected.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Page does not open / keeps spinning | Confirm the Tailscale app shows Connected; disconnect and reconnect once, then retry |
| The approval page appears again | On the computer panel confirm the device is Allowed; if it is not listed, reload the page in Safari once |
| No push notifications | In ntfy confirm the subscription exists; iOS Settings → Notifications → ntfy → Allow Notifications |
| Home-screen icon fails to open | Long-press and remove the icon, open the 3443 address in Safari again after approval, then re-add |
| Very old iOS (15 or below) | Basic features work, but layout and full-screen PWA are incomplete — consider upgrading |

## 8. Security notes

- All access runs inside the Tailscale encrypted tunnel + HTTPS; only devices
  under your account can reach it.
- Unapproved devices cannot enter; approval records can be revoked from the
  LAN Access panel on the computer.
- New iPhone: install Tailscale and sign in with the same account → open the
  3443 address → approve the new device on the computer panel → re-add to the
  home screen.
