# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
