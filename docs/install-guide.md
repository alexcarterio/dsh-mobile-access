# DSH Android access — installation guide

> Goal: securely reach your local DSH web UI from a phone (full web features),
> with a phone-friendly layout and a home-screen "install and launch" experience.

## 1. Architecture

```text
Android phone ──(Tailscale WireGuard tunnel, no public ports)──▶ desktop 0.0.0.0:3088 (lan-gate gate)
   │   device token + desktop approval + rate limit + HttpOnly cookie
   ▼
127.0.0.1:3080 (DSH web, bound to localhost only, never public)
```

### Three lines of defense

1. **Network layer** — inbound traffic to the gate port (`3088`) is allowed only
   from your Tailscale subnet (`100.64.0.0/10`), e.g. via a Windows Firewall
   rule named `DSH LAN Gate (Tailscale only)`. Other LAN devices and the public
   internet stay unreachable.
2. **Application layer** — every device's first access requires desktop approval,
   after which it receives a 128-bit random token (one-time claim + `HttpOnly`
   cookie + `SameSite`). Revoking drops the connection.
3. **Host process** — the DSH web server stays bound to the default
   `127.0.0.1:3080`; only the in-process gate proxy reaches it.

## 2. Install the plugin

1. Copy `lan-gate.mjs` to `%USERPROFILE%\.dsh\lan-gate\lan-gate.mjs`
   (or `~/.dsh/lan-gate/lan-gate.mjs` on macOS/Linux).
2. Register it in `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` — see
   [`cordis.patch.yml.example`](../cordis.patch.yml.example) for the exact block.
3. Restart DSH. The gate proxy then listens on `0.0.0.0:3088` and forwards to
   `127.0.0.1:3080`.

## 3. Set up Tailscale

1. Install Tailscale on the desktop and on the phone.
2. Log both devices into the **same** Tailscale account.
3. On the desktop, authorize the device (`tailscale login` opens a one-time
   authorization link).
4. Confirm both devices appear in the Tailscale admin console.

Find the desktop's Tailscale IP:

```text
tailscale ip -4
```

## 4. First access from the phone (requires desktop approval)

1. On the phone, keep Tailscale connected and browse to:

   ```text
   http://<machine-tailscale-ip>:3088
   ```

2. The phone shows a "waiting for approval" page.
3. On the desktop DSH, open **Settings → LAN Access**, find the pending device,
   choose access mode **Phone**, and tap **Allow**.
4. The phone automatically proceeds into the DSH UI.

> Keep Tailscale running in the background on the phone (allow auto-start and
> ignore battery optimization).

## 5. Install to the home screen (PWA)

Use the HTTPS address (Tailscale Serve provides a valid certificate, which is
what makes Chrome offer the "Install app" flow):

1. On the phone, open Chrome at
   `https://<your-device>.your-tailnet.ts.net:3443`.
2. **⋮ → Install app / Add to Home screen** → a DSH icon appears on the home
   screen; tapping it launches full-screen.

The Serve configuration command:

```text
tailscale serve --bg --yes --https=3443 http://127.0.0.1:3088
```

- Inspect: `tailscale serve status`
- Remove: `tailscale serve reset`

> The HTTP direct address (`http://<machine-tailscale-ip>:3088`) still goes
> through the device-approval gate; the HTTPS address goes through Tailscale
> Serve at the network layer. Both are restricted to your tailnet; day-to-day,
> the HTTPS address is the convenient one.

See [`pwa-setup.md`](../pwa/pwa-setup.md) for how the PWA assets are applied to
the DSH frontend.

## 6. Phone notifications (ntfy)

**Triggers** — DSH task complete (high priority) / needs approval or asks you a
question (highest priority) → system notification + default sound; tapping
expands the details (no deep link — see Limitations).

**Flow** — `dsh-push/dsh_push.py` (a standalone process that reads session logs
read-only, without touching DSH) → ntfy → the ntfy app on your phone.

| Item | Value |
|---|---|
| Topic (subscription) | `<your-ntfy-topic>` — treat it like a secret, never publish it |
| Push server | `ntfy.sh` (public); override with the `NTFY_URL` environment variable to self-host |
| Phone app | [ntfy](https://ntfy.sh/) — on some Android skins, allow auto-start, unrestricted battery, and lock the recents card |
| Desktop service | run `pythonw` in the background; optionally a scheduled task to keep it alive (single-instance lock) |
| Log | `dsh-push/dsh_push.log` |
| Test | `py dsh-push/dsh_push.py --test` |

Environment variables: `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN` (optional access
token). On Windows, [`dsh-push/start_push.bat`](../dsh-push/start_push.bat) starts
it as a background process.

> Only main sessions are pushed (subagent sessions are filtered). Session titles
> are included in notifications — self-host ntfy over Tailscale if title privacy
> matters.

## 7. Maintenance

| Task | How |
|---|---|
| New phone | Install Tailscale, log into the same account, open `:3088`, approve on desktop (revoke old devices in the panel) |
| Plugin status | Desktop **Settings → LAN Access** panel, or `http://127.0.0.1:3080/lan-gate/status` |
| Approval records | `%USERPROFILE%\.dsh\lan-gate-state.json` (delete to reset all approvals) |
| Port conflict | Change `LAN_GATE_PORT` (env) or the `PROXY_PORT` constant in `lan-gate.mjs` |
| Rate-limited (429) | The limit is 3000 requests/minute per IP; if you hit it, wait a minute |
| DSH restart | Nothing to do — the plugin auto-loads from `cordis.patch.yml`; approvals persist; Tailscale Serve recovers automatically |
| Adding a workspace from the phone | Use the browser directory-browse backend (mount `dsh-host-directory-picker-browse` instead of the native picker) so the picker renders in the web UI |
| Sending images from the phone | The injected bottom-right 🖼 / 📷 buttons reuse the paste path; first camera/gallery launch has a cold-start delay |
| Updating the plugin | Replace `lan-gate.mjs` in place and restart DSH (re-audit before updating) |
| Uninstall | Remove the `lan-gate` block from `cordis.patch.yml`, delete the plugin file, and remove the firewall rule (`netsh advfirewall firewall delete rule name="DSH LAN Gate (Tailscale only)"`) |

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Phone stuck on "waiting for approval" | Approve the device in **Settings → LAN Access** on the desktop |
| "Token bound to another browser" | The token was claimed by another browser; revoke the device, then approve again |
| 429 "Too many requests" | Per-IP rate limit hit; wait a minute |
| No "Install app" in Chrome | Use the HTTPS (Tailscale Serve) address; refresh once so the manifest loads |
| PWA changes gone after DSH upgrade | DSH rebuilds its frontend `dist`; re-apply [`pwa-setup.md`](../pwa/pwa-setup.md) |
| Phone cannot reach `:3088` | Check Tailscale is connected and the firewall allows the Tailscale subnet on `3088` |
| No push notifications | Run `py dsh_push.py --test`; verify `NTFY_TOPIC` matches the topic subscribed in the ntfy app |

## 9. Known limitations

1. **No end-to-end HTTPS** — the app layer is plain HTTP inside the WireGuard
   tunnel; the tunnel is the encryption boundary.
2. **Depends on the Tailscale control plane** — registration and discovery rely
   on Tailscale's coordination service (data is peer-to-peer). For full
   self-hosting, consider `headscale`.
3. **Same process as DSH** — the plugin has been line-audited (no external
   calls, no subprocess, no dependencies); re-check compatibility after DSH
   upgrades.
4. **PWA icons** — the manifest ships PNG (192/512/maskable) plus SVG fallback;
   WebAPK install requires the PNGs. A DSH upgrade reverts the `dist` changes.
5. **Control routes depend on `127.0.0.1:3080`** — never bind DSH itself to
   `0.0.0.0` (e.g. via a `dsh-lan-access`-style plugin), or the local-only
   control-route protection breaks.
6. **Notifications do not deep-link** — Tailscale domains cannot pass WebAPK App
   Links verification, so tapping a notification opens the browser rather than
   the installed app.
