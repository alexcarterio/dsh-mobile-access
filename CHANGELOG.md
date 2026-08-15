# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Platform user guides: `docs/phone-guide-ios.md` and
  `docs/phone-guide-android.md` (preparation, connection, PWA install, ntfy
  push, troubleshooting, and security notes for each platform).
- README phone-setup section restructured: platform guide table up front,
  desktop-side steps (Tailscale, Serve, ntfy) after it.

### Fixed

- Message duplication: the PROXY-protocol parser no longer unshifts
  non-PROXY bytes back into the socket stream (the HTTP parser already received
  them, so unshifting made every request parse and forward twice).
- Double panel injection: `injectPanel` is guarded by a global
  `Symbol.for('dsh.lan-gate.applied')` flag.
- ntfy delivery breaking when a local proxy (e.g. Clash) is off: `dsh_push`
  now bypasses proxies (`proxies={"http": None, "https": None}`).

### Changed

- Add a forwarding log (`~/.dsh/lan-gate/forward.log`) for prompt submissions
  and non-2xx/3xx responses; the claim ticket in the query string is redacted.

## [1.0.5] - 2026-08-15

### Changed

- Fully decouple from the desktop pet repository: remove all cross-repository
  references from `dsh-push` docs and code headers. This repository is
  self-contained.

## [1.0.4] - 2026-08-15

### Changed

- Adopt the phone push helper as the maintained home of `dsh-push` (previously
  shared with the deepseek-whale-pet repository, which now points here).
- Add `dsh-push/README.md` with the full setup guide, privacy notes, and the
  relationship to the pet repository.
- Mark `dsh-push/dsh_watch.py` as a mirror of the canonical copy in the
  deepseek-whale-pet repository.

## [1.0.3] - 2026-08-15

### Changed

- Mark expired approvals in the admin panel with a red "(expired)" badge and an
  explanation line.
- Fix stale troubleshooting entries in the install guide (the "bound to another
  browser" page no longer exists; document same-IP re-claim and 90-day expiry).

## [1.0.2] - 2026-08-15

### Fixed

- Replace the PWA service worker with a pure network pass-through version
  (clears legacy caches on activation, intercepts nothing). The previous
  cache-first strategy mixed stale assets with DSH's module rev mechanism and
  caused broken page states.
- Remove the dead `boundPage` gate page replaced by same-IP re-claim.

## [1.0.1] - 2026-08-15

### Security

- Resolve the real client IP for Tailscale Serve entries: trust `x-forwarded-for`
  only when the connection comes from loopback and carries the
  `tailscale-user-login` header, so per-device approval applies to each tailnet
  device instead of collapsing them all into the local machine.
- Strip forwarded headers (`x-forwarded-host`, `x-forwarded-proto`, `x-real-ip`,
  `forwarded`) before proxying.
- Add an `Origin` allow-list check (loopback / LAN IPs / `*.ts.net`) on the
  control routes (`/lan-gate/status`, `/lan-gate/action`, `/lan-gate/upload`).
- Add a 90-day token TTL (`TOKEN_TTL_MS`); expired approvals fall back to the
  "awaiting approval" gate.

### Fixed

- Fix the approval claim loop: the claim branch now precedes auto re-claim,
  preventing an infinite redirect.
- Strip the replayed HTTP request bytes at the start of an upgraded WebSocket
  stream (Tailscale Serve reverse proxy behavior).
- Set the `Secure` flag on the token cookie for Serve (HTTPS) requests.
- Close the connection after each response and disable upstream keep-alive
  reuse to eliminate cross-wired responses.

## [1.0.0] - 2026-08-15

### Added

- Initial public release of the dsh-mobile-access kit.
- `lan-gate.mjs` plugin: device approval flow, per-device access modes
  (auto/phone/desktop), token + cookie binding, per-IP rate limiting
  (3000 requests/minute), mobile layout injection, attachment upload endpoint
  (20 MB cap, 7-day cleanup), phone gallery/camera buttons, and an in-app
  admin panel under Settings → LAN Access.
- `dsh-push/`: standalone ntfy pusher for DSH session events
  (waiting-for-user → high priority, turn-done → normal priority).
- `pwa/`: PWA assets (icons, manifest, service worker) plus setup instructions
  for the DSH web frontend.
- `tools/parse_file.py`: attachment parser for txt/docx/pdf/zip/7z/rar.
- English installation guide covering the Tailscale phone setup, PWA
  installation, and ntfy configuration.
