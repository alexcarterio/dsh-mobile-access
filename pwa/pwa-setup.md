# PWA assets — how to apply them to the DSH frontend

This folder contains the five assets that turn the DSH web UI into an installable
Progressive Web App. They target the built frontend `dist` served by DSH (under
the `@deepseek-ai/dsh-web-frontend` package). **A DSH upgrade rebuilds/replaces
that `dist`, so re-apply these steps after every upgrade.**

## Assets

| File | Purpose |
|---|---|
| `icon-192.png` | 192×192 PNG icon (`any` purpose) and `apple-touch-icon`. |
| `icon-512.png` | 512×512 PNG icon (`any` and `maskable` purpose). |
| `icon-512.svg` | SVG icon fallback. |
| `manifest.webmanifest` | Web app manifest (name, icons, display mode, scope). |
| `sw.js` | Service worker that only clears legacy caches on activation, then passes every request straight to the network (no caching). This is deliberate: asset caching mixes stale builds with DSH's module rev mechanism and causes broken page states. |

## Steps

1. **Copy the assets** into the frontend `dist` root so they are served at the
   site root:

   ```text
   dist/icon-192.png
   dist/icon-512.png
   dist/icon-512.svg
   dist/manifest.webmanifest
   dist/sw.js
   ```

2. **Link the manifest and theme** — in `dist/index.html`, add inside `<head>`:

   ```html
   <link rel="manifest" href="/manifest.webmanifest" />
   <meta name="theme-color" content="#0f1115" />
   ```

3. **Apple touch icon** — add the following `<head>` entry (iOS uses this for the
   home-screen icon and splash):

   ```html
   <link rel="apple-touch-icon" href="/icon-192.png" />
   ```

   Optionally also add iOS full-screen metadata:

   ```html
   <meta name="apple-mobile-web-app-capable" content="yes" />
   <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
   ```

4. **Register the service worker** — add before `</body>` in `dist/index.html`
   (only register in a secure context, which `tailscale serve` provides):

   ```html
   <script>
     if ('serviceWorker' in navigator && location.protocol === 'https:') {
       navigator.serviceWorker.register('/sw.js').catch(function () {});
     }
   </script>
   ```

## `favicon.svg` note

`manifest.webmanifest` lists `/favicon.svg` as an icon. Either:

- also provide a `favicon.svg` at the site root, **or**
- delete the `/favicon.svg` entry from `manifest.webmanifest` if you do not
  ship one.

A manifest that references a missing icon can still install, but a missing
`favicon.svg` is unnecessary cruft — keep the manifest consistent with the files
you actually serve.

## Verification

- Open the site over HTTPS (e.g. `https://<your-device>.your-tailnet.ts.net:3443`).
- In Chrome: **⋮ → Install app / Add to Home screen** should appear.
- In DevTools → Application → Manifest, confirm the manifest parses and all
  referenced icons resolve (HTTP 200).
