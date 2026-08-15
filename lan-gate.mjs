// DSH LAN access gateway (final, self-contained).
// Purpose: LAN devices reach the local DSH through a reverse proxy on
//       0.0.0.0:3088; first access requires approval on this machine;
//       each device can pick an access mode (auto/phone/desktop); phone mode
//       injects the compact layout.
// Security: device token + cookie binding (one approval binds one browser,
//       one-time token claim); per-IP per-minute rate limit (default 120,
//       429 on overflow); the listen address can be tightened to 127.0.0.1
//       via LAN_GATE_HOST; LAN_GATE_PORT / LAN_GATE_HOST override port and host.
// Admin panel: injected into the DSH "Settings" UI (Settings → LAN Access).
// Install point: .dsh/profiles/web/cordis.patch.yml (auto-loaded after a DSH
//       restart, runs in-process, no subprocess).

import { networkInterfaces, homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'lan-gate'
export const inject = ['webServer']

// Quick overrides via environment variables: LAN_GATE_PORT / LAN_GATE_HOST
const PROXY_PORT = Number(process.env.LAN_GATE_PORT || 3088)
// Use '127.0.0.1' when a reverse proxy/tunnel sits in front (also overridable
// via the environment variable).
const LISTEN_HOST = process.env.LAN_GATE_HOST || '0.0.0.0'
// Per-IP per-minute request cap (sliding window); 429 when exceeded.
// The upstream default of 120 is too low for the DSH frontend (first paint
// loads KaTeX fonts/locale packs/multiple RPCs; measured peaks exceed 120/min).
// Raised to 3000 (~50/sec) — impossible to hit in normal use while still
// catching scanners and brute-force attempts.
// Takes effect after a DSH restart.
const RATE_LIMIT_PER_MIN = 3000
const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = 3080

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'lan-gate-state.json')
}

function loadDecisions() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (raw && typeof raw === 'object' && raw.decisions && typeof raw.decisions === 'object') return raw.decisions
  } catch (_err) {
    // Treat a missing or corrupt state file as empty decisions
  }
  return {}
}

function saveDecisions(decisions) {
  try {
    fs.mkdirSync(dshHome(), { recursive: true })
    const tmp = stateFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ decisions }, null, 2), 'utf8')
    fs.renameSync(tmp, stateFile())
  } catch (_err) {
    // Persistence failure must not affect the running state
  }
}

function lanIps() {
  const result = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info && info.family === 'IPv4' && !info.internal) result.push(info.address)
    }
  }
  return result
}

function normalizeIp(raw) {
  return String(raw || '').replace(/^::ffff:/, '')
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
}

// Approval token validity: 90 days. After expiry the device falls back to
// "awaiting approval" and must be allowed again on this machine.
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000

function deviceKind(decisions, ip) {
  if (!isAllowed(decisions, ip)) return undefined
  const d = decisions[ip]
  return d.kind === 'phone' || d.kind === 'desktop' ? d.kind : undefined
}

function isAllowed(decisions, ip) {
  const d = decisions[ip]
  if (d === undefined || d.allow !== true || d.revoked === true) return false
  return Date.now() - (d.at || 0) < TOKEN_TTL_MS
}

function randomToken() {
  return randomBytes(16).toString('hex')
}

function parseCookies(req) {
  const out = {}
  const header = req.headers.cookie
  if (typeof header !== 'string' || header === '') return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key !== '') out[key] = value
  }
  return out
}

function queryTicket(url) {
  const q = String(url || '').indexOf('?')
  if (q < 0) return undefined
  const m = url.slice(q + 1).match(/(?:^|&)t=([^&]*)/)
  return m ? decodeURIComponent(m[1]) : undefined
}

function setTokenCookie(res, token, secure) {
  const flags = 'Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '')
  res.setHeader('Set-Cookie', 'lg_token=' + token + '; ' + flags)
}

// ---- gate pages (mobile-optimized) ----

function gatePage(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="theme-color" content="#0f1115">'
    + '<title>' + title + '</title><style>'
    + '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}'
    + 'html,body{margin:0;padding:0}'
    + 'body{min-height:100dvh;display:flex;align-items:center;justify-content:center;'
    + 'font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;'
    + 'background:radial-gradient(1100px 700px at 50% -10%,#1b2233 0%,#0f1115 55%);color:#e6e8ec;'
    + 'padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) '
    + 'max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));'
    + '-webkit-text-size-adjust:100%;text-size-adjust:100%}'
    + '.card{width:100%;max-width:460px;margin:0 auto;padding:38px 26px 30px;'
    + 'border:1px solid #2a2f3a;border-radius:20px;background:#161a22;text-align:center;'
    + 'box-shadow:0 20px 60px rgba(0,0,0,.45)}'
    + '.logo{width:56px;height:56px;margin:0 auto 18px;border-radius:16px;'
    + 'background:linear-gradient(135deg,#4c8dff,#7a5cff);display:flex;align-items:center;justify-content:center;'
    + 'font-size:24px;font-weight:700;color:#fff}'
    + 'h1{font-size:21px;margin:0 0 6px}'
    + '.sub{font-size:14px;color:#9aa3b2;margin:0 0 16px}'
    + '.ip{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:15px;color:#8fa3c8;'
    + 'background:#0b0e14;border:1px solid #232a37;border-radius:10px;padding:10px 16px;'
    + 'display:inline-block;margin:10px 0 4px;word-break:break-all}'
    + '.spinner{width:38px;height:38px;margin:20px auto;border-radius:50%;'
    + 'border:3px solid #2a2f3a;border-top-color:#4c8dff;animation:spin .9s linear infinite}'
    + '@keyframes spin{to{transform:rotate(360deg)}}'
    + 'p{font-size:14px;line-height:1.8;color:#9aa3b2;margin:8px 0}'
    + '.bar{height:3px;border-radius:99px;background:#232a37;overflow:hidden;margin:20px auto 0;max-width:220px}'
    + '.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4c8dff,#7a5cff);animation:fill 2.5s linear infinite}'
    + '@keyframes fill{from{width:0}to{width:100%}}'
    + '.btn{display:inline-block;margin-top:18px;padding:11px 30px;font-size:15px;font-weight:600;'
    + 'border:1px solid #4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08);border-radius:12px;'
    + 'cursor:pointer;text-decoration:none;touch-action:manipulation;user-select:none}'
    + '.btn:active{background:rgba(76,141,255,.22)}'
    + '.bad{color:#f0716f}'
    + '</style></head><body><div class="card">' + body + '</div></body></html>'
}

function pendingPage(ip) {
  return gatePage('Awaiting approval · DSH LAN Access',
    '<div class="logo">DSH</div>'
    + '<h1>Waiting for approval on this machine</h1>'
    + '<p class="sub">First access needs confirmation on the desktop</p>'
    + '<div class="spinner"></div>'
    + '<p>Device</p><span class="ip">' + ip + '</span>'
    + '<p>Approve this device from the DSH UI on the desktop:<br>Settings → LAN Access → Allow</p>'
    + '<p style="font-size:12px;color:#8b93a3">⚠️ After approval this device gains full control over DSH on this machine'
    + ' (command execution, file read/write, approval actions). Approve only your own devices;'
    + ' prefer the HTTPS (Tailscale) entry and avoid plaintext direct addresses on public networks.</p>'
    + '<a class="btn" href="javascript:location.reload()">Check now</a>'
    + '<div class="bar"><i></i></div>'
    + '<script>setTimeout(function(){location.reload()},2500)</script>')
}

function deniedPage(ip) {
  return gatePage('Access denied · DSH LAN Access',
    '<div class="logo">DSH</div>'
    + '<h1>Access denied</h1>'
    + '<p class="sub">This device is not approved on this machine</p>'
    + '<p class="bad">Device ' + ip + ' is not allowed to access the DSH on this machine.</p>'
    + '<p>To allow it again, use the "Settings → LAN Access" page in the DSH UI on this machine.</p>'
    + '<a class="btn" href="javascript:location.reload()">Check again</a>'
    + '<script>setTimeout(function(){location.reload()},4000)</script>')
}

function rateLimitPage(ip) {
  return gatePage('Too many requests · DSH LAN Access',
    '<div class="logo">DSH</div>'
    + '<h1>Too many requests</h1>'
    + '<p class="sub">Per-minute request limit reached</p>'
    + '<p class="bad">Device ' + ip + ' exceeded the limit of ' + RATE_LIMIT_PER_MIN + ' requests per minute.</p>'
    + '<p>Please wait a minute and try again.</p>'
    + '<a class="btn" href="javascript:location.reload()">Reload</a>')
}

// ---- reverse proxy (in-process, with Host rewrite and device-attribute injection) ----

function cleanHeaders(headers, clientIp) {
  const drop = { host: 1, origin: 1, connection: 1, 'proxy-connection': 1, 'keep-alive': 1, te: 1, trailer: 1, 'transfer-encoding': 1, upgrade: 1, 'proxy-authorization': 1, 'proxy-authenticate': 1, 'x-forwarded-host': 1, 'x-forwarded-proto': 1, 'x-real-ip': 1, forwarded: 1 }
  const out = {}
  for (const key of Object.keys(headers || {})) {
    if (drop[String(key).toLowerCase()]) continue
    out[key] = headers[key]
  }
  out['host'] = TARGET_HOST + ':' + TARGET_PORT
  out['x-forwarded-for'] = clientIp
  return out
}

function injectDeviceAttr(html, kind) {
  const m = html.match(/<html[^>]*/i)
  if (!m) return html
  return html.slice(0, m.index) + m[0] + ' data-lan-device="' + kind + '"' + html.slice(m.index + m[0].length)
}

function forwardRequest(decisions, req, res, clientIp) {
  const headers = cleanHeaders(req.headers, clientIp)
  const upstream = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: headers,
    // Do not reuse the keep-alive pool: reusing a connection while a request is
    // force-refreshed/aborted causes cross-wired responses (rpcId mismatch).
    agent: false,
  }, (upRes) => {
    const outHeaders = {}
    for (const key of Object.keys(upRes.headers)) outHeaders[key] = upRes.headers[key]
    // Close the connection when the response ends: disable connection reuse at
    // both the browser and Tailscale Serve layers, eliminating cross-wired responses.
    outHeaders['connection'] = 'close'
    const contentType = String(outHeaders['content-type'] || '')
    const isHtml = contentType.indexOf('text/html') >= 0
    // Disable caching for module bundles/JSON: after a restart the rev changes,
    // preventing the browser from mixing old and new builds (module load failures).
    if (contentType.indexOf('javascript') >= 0 || contentType.indexOf('json') >= 0) outHeaders['cache-control'] = 'no-store'
    if (isHtml) outHeaders['cache-control'] = 'no-store'
    const kind = deviceKind(decisions, clientIp)
    if (isHtml && kind !== undefined) {
      const chunks = []
      let size = 0
      let sent = false
      const flush = () => {
        if (sent) return
        sent = true
        try {
          let html = Buffer.concat(chunks).toString('utf8')
          html = injectDeviceAttr(html, kind)
          res.writeHead(upRes.statusCode || 502, outHeaders)
          res.end(html)
        } catch (_err) {
          try { res.end() } catch (_err2) { /* connection closed */ }
        }
      }
      upRes.on('data', (chunk) => {
        if (sent) return
        if (size + chunk.length > 524288) { flush(); return }
        size += chunk.length
        chunks.push(chunk)
      })
      upRes.on('end', flush)
      upRes.on('error', flush)
      return
    }
    try { res.writeHead(upRes.statusCode || 502, outHeaders) } catch (_err) { /* headers already sent */ }
    upRes.pipe(res)
  })
  upstream.on('error', () => {
    try {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Bad Gateway')
    } catch (_err) { /* connection closed */ }
  })
  res.on('close', () => { try { upstream.destroy() } catch (_err) { /* destroyed */ } })
  req.pipe(upstream)
}

// ---- index injection: polyfill + device layout + settings admin panel ----

const UUID_POLYFILL = 'if(typeof crypto!=="undefined"&&typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=Array.prototype.map.call(b,function(x){return x.toString(16).padStart(2,"0")}).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}'

const DEVICE_CSS = '<style>'
  + 'html[data-lan-device="phone"]{-webkit-text-size-adjust:100%;text-size-adjust:100%}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"] [data-phase]{--dsh-composer-side-clearance:2px;--dsw-font-s-14-font-size:12px;--dsw-font-xs-13-font-size:11px;--dsw-font-xxs-12-font-size:10.5px;--dsw-font-xxxs-11-font-size:9.5px}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"] [data-phase]{--dsw-font-markdown-base-font-size:13.5px;--dsw-font-markdown-base-strong-font-size:13.5px;--dsw-font-markdown-base-italic-font-size:13.5px;--dsw-font-markdown-base-strong-italic-font-size:13.5px;--dsw-font-markdown-small-font-size:12px;--dsw-font-markdown-small-strong-font-size:12px;--dsw-font-markdown-small-italic-font-size:12px;--dsw-font-markdown-small-strong-italic-font-size:12px;--dsw-font-markdown-code-font-size:11.5px;--dsw-font-markdown-code-block-font-size:11px;--dsw-font-markdown-code-block-small-font-size:10px;--dsw-font-markdown-table-font-size:12px;--dsw-font-markdown-table-head-font-size:12px;--dsw-font-markdown-h1-font-size:17px;--dsw-font-markdown-h2-font-size:15px;--dsw-font-markdown-h3-font-size:14px;--dsw-font-markdown-h4-font-size:13px}'
  + 'html[data-lan-device="phone"] [data-chat-flow]{line-height:1.4;gap:6px}'
  + 'html[data-lan-device="phone"] [data-chat-flow] pre{font-size:11px;max-width:100%}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"] input,html[data-lan-device="phone"] [data-slot="conversation"] textarea{font-size:16px}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"] button,html[data-lan-device="phone"] [data-slot="sidebar"] button{min-height:32px;touch-action:manipulation}'
  + 'html[data-lan-device="phone"] [data-slot="conversation"],html[data-lan-device="phone"] [data-slot="sidebar"]{-webkit-tap-highlight-color:transparent}'
  + 'html[data-lan-device="phone"] [data-composer-card] button{min-height:28px}'
  + 'html[data-lan-device="phone"] [data-composer-card] select{max-width:120px;font-size:12px;height:24px;padding:0 14px 0 6px}'
  + 'html[data-lan-device="phone"] [data-composer-card] > div:last-child > div:first-child{gap:8px}'
  + 'html[data-lan-device="phone"] [data-composer-card] > div:last-child > div:last-child{flex:0 1 auto;min-width:0;gap:8px}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"]{display:flex;flex-direction:column;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;border-radius:0}'
  + 'html[data-lan-device="phone"] [role="presentation"]:has([role="dialog"]){padding:0}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"] nav{width:100%;flex:none;flex-direction:column;gap:6px;padding:10px 12px 6px}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"] nav>div:last-child{display:flex;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:4px}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"] > div:last-child{flex:1;min-height:0}'
  + 'html[data-lan-device="phone"] [role="dialog"][aria-modal="true"] > div:last-child > div:last-child{flex:1;min-height:0;overflow-y:auto}'
  + 'html[data-lan-device="phone"] [data-slot="conversation.input.model"] [role="menu"]{position:fixed;left:12px;right:auto;top:auto;bottom:calc(env(safe-area-inset-bottom) + 110px);width:min(280px,calc(100vw - 24px));max-height:min(320px,calc(100dvh - 300px));z-index:120}'
  + 'html[data-lan-device="phone"] [data-composer-card] [role="dialog"]{position:fixed;right:max(8px,env(safe-area-inset-right));left:auto;top:96px;bottom:90px;width:min(320px,calc(100vw - 72px));max-height:min(420px,calc(100dvh - 200px));z-index:120}'
  + '@media (max-width:820px){'
  + 'html:not([data-lan-device="desktop"]){-webkit-text-size-adjust:100%;text-size-adjust:100%}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"] [data-phase]{--dsh-composer-side-clearance:2px;--dsw-font-s-14-font-size:12px;--dsw-font-xs-13-font-size:11px;--dsw-font-xxs-12-font-size:10.5px;--dsw-font-xxxs-11-font-size:9.5px}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"] [data-phase]{--dsw-font-markdown-base-font-size:13.5px;--dsw-font-markdown-base-strong-font-size:13.5px;--dsw-font-markdown-base-italic-font-size:13.5px;--dsw-font-markdown-base-strong-italic-font-size:13.5px;--dsw-font-markdown-small-font-size:12px;--dsw-font-markdown-small-strong-font-size:12px;--dsw-font-markdown-small-italic-font-size:12px;--dsw-font-markdown-small-strong-italic-font-size:12px;--dsw-font-markdown-code-font-size:11.5px;--dsw-font-markdown-code-block-font-size:11px;--dsw-font-markdown-code-block-small-font-size:10px;--dsw-font-markdown-table-font-size:12px;--dsw-font-markdown-table-head-font-size:12px;--dsw-font-markdown-h1-font-size:17px;--dsw-font-markdown-h2-font-size:15px;--dsw-font-markdown-h3-font-size:14px;--dsw-font-markdown-h4-font-size:13px}'
  + 'html:not([data-lan-device="desktop"]) [data-chat-flow]{line-height:1.4;gap:6px}'
  + 'html:not([data-lan-device="desktop"]) [data-chat-flow] pre{font-size:11px;max-width:100%}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"] input,html:not([data-lan-device="desktop"]) [data-slot="conversation"] textarea{font-size:16px}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"] button,html:not([data-lan-device="desktop"]) [data-slot="sidebar"] button{min-height:32px;touch-action:manipulation}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation"],html:not([data-lan-device="desktop"]) [data-slot="sidebar"]{-webkit-tap-highlight-color:transparent}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] button{min-height:28px}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] select{max-width:120px;font-size:12px;height:24px;padding:0 14px 0 6px}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] > div:last-child > div:first-child{gap:8px}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] > div:last-child > div:last-child{flex:0 1 auto;min-width:0;gap:8px}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"]{display:flex;flex-direction:column;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;border-radius:0}'
  + 'html:not([data-lan-device="desktop"]) [role="presentation"]:has([role="dialog"]){padding:0}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] nav{width:100%;flex:none;flex-direction:column;gap:6px;padding:10px 12px 6px}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] nav>div:last-child{display:flex;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:4px}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] > div:last-child{flex:1;min-height:0}'
  + 'html:not([data-lan-device="desktop"]) [role="dialog"][aria-modal="true"] > div:last-child > div:last-child{flex:1;min-height:0;overflow-y:auto}'
  + 'html:not([data-lan-device="desktop"]) [data-slot="conversation.input.model"] [role="menu"]{position:fixed;left:12px;right:auto;top:auto;bottom:calc(env(safe-area-inset-bottom) + 110px);width:min(280px,calc(100vw - 24px));max-height:min(320px,calc(100dvh - 300px));z-index:120}'
  + 'html:not([data-lan-device="desktop"]) [data-composer-card] [role="dialog"]{position:fixed;right:max(8px,env(safe-area-inset-right));left:auto;top:96px;bottom:90px;width:min(320px,calc(100vw - 72px));max-height:min(420px,calc(100dvh - 200px));z-index:120}'
  + '}'
  + '</style>'

const PANEL_CSS = '<style>'
  + '.lg-nav-cell{display:flex;align-items:center;gap:8px;height:40px;padding:9px 16px 9px 12px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary);text-align:left;white-space:nowrap;flex:none}'
  + '.lg-nav-cell:hover{background:var(--dsw-specific-sidebar-nav-item-hover,var(--dsw-alias-bg-layer-2))}'
  + '.lg-nav-active{background:var(--dsw-specific-sidebar-nav-item-active,var(--dsw-alias-bg-layer-2))}'
  + '.lg-section-on button:not([data-lg-nav]){background:transparent;color:var(--dsw-alias-label-primary);font-weight:400}'
  + '.lg-nav-icon{flex:none}'
  + '.lg-panel{display:flex;flex-direction:column;gap:10px}'
  + '.lg-panel .lg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}'
  + '.lg-panel .lg-badge{display:inline-flex;align-items:center;font-size:12px;border-radius:999px;padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}'
  + '.lg-panel .lg-badge-running{color:var(--dsw-alias-state-success-primary);border-color:currentColor}'
  + '.lg-panel .lg-badge-starting{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}'
  + '.lg-panel .lg-badge-error{color:var(--dsw-alias-state-error-primary);border-color:currentColor}'
  + '.lg-panel .lg-badge-stopped{color:var(--dsw-alias-state-error-primary);border-color:currentColor}'
  + '.lg-panel .lg-label{font-size:13px;font-weight:600;margin:10px 0 6px;color:var(--dsw-alias-label-primary)}'
  + '.lg-panel .lg-muted{color:var(--dsw-alias-label-secondary);font-size:13px;margin:4px 0}'
  + '.lg-panel .lg-small{font-size:12px}'
  + '.lg-panel .lg-ip{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:var(--dsw-alias-label-primary)}'
  + '.lg-panel .lg-url{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px;margin:4px 0;word-break:break-all;cursor:pointer}'
  + '.lg-panel .lg-item{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}'
  + '.lg-panel .lg-item:last-child{border-bottom:none}'
  + '.lg-panel .lg-row{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}'
  + '.lg-panel .lg-btn{font-size:12px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 12px;cursor:pointer}'
  + '.lg-panel .lg-btn:hover{background:var(--dsw-alias-bg-layer-2)}'
  + '.lg-panel .lg-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}'
  + '.lg-panel .lg-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}'
  + '.lg-panel .lg-kind-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}'
  + '.lg-panel .lg-error{color:var(--dsw-alias-state-error-primary);font-size:13px;margin:4px 0}'
  + '.lg-nav-holder{flex:1;min-height:0;overflow-y:auto;padding:0 24px 24px}'
  + '</style>'

// Phone image pick buttons (gallery/camera): inject floating buttons that reuse
// the desktop paste path via a synthetic paste event; when paste is unavailable,
// fall back to inserting an <img> into the contenteditable editor.
const IMG_BTN_CSS = '<style>'
  + '.lg-imgbar{position:fixed;right:12px;bottom:118px;display:none;gap:8px;z-index:999;pointer-events:none}'
  + '.lg-imgbar button{pointer-events:auto;width:40px;height:40px;border-radius:50%;border:1px solid rgba(160,170,190,.4);background:rgba(22,26,34,.95);color:#d6dde8;font-size:18px;line-height:1;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);touch-action:manipulation}'
  + '@media (max-width:820px){html:not([data-lan-device="desktop"]) .lg-imgbar{display:flex}}'
  + '</style>'

const IMG_BTN_JS = '<scr' + 'ipt>'
  + '(function(){'
  + 'function editor(){var h=document.querySelector(\'[data-composer-card]\');var s=h||document;return s.querySelector(\'[contenteditable="true"],textarea,[role="textbox"]\')}'
  + 'function firePaste(file){var e=editor();if(!e)return false;try{var dt=new DataTransfer();dt.items.add(file);e.dispatchEvent(new ClipboardEvent(\'paste\',{bubbles:true,cancelable:true,clipboardData:dt}));return true}catch(_e){return false}}'
  + 'function insertImg(url){var e=editor();if(!e)return;try{e.focus();var sel=window.getSelection();var r=document.createRange();r.selectNodeContents(e);r.collapse(false);sel.removeAllRanges();sel.addRange(r);var im=document.createElement(\'img\');im.src=url;im.style.maxWidth=\'100%\';r.insertNode(im);r.setStartAfter(im);r.collapse(true);sel.removeAllRanges();sel.addRange(r);e.dispatchEvent(new InputEvent(\'input\',{bubbles:true,inputType:\'insertFromPaste\'}))}catch(_e){}}'
  + 'function pick(cap){var i=document.createElement(\'input\');i.type=\'file\';i.accept=\'image/*\';if(cap){i.setAttribute(\'capture\',\'environment\')}i.style.display=\'none\';document.body.appendChild(i);i.onchange=function(){var f=i.files&&i.files[0];if(!f){i.remove();return}if(!firePaste(f)){var rd=new FileReader();rd.onload=function(){insertImg(rd.result);i.remove()};rd.readAsDataURL(f)}else{i.remove()}};i.click()}'
  + 'function boot(){if(document.querySelector(\'.lg-imgbar\'))return;var b=document.createElement(\'div\');b.className=\'lg-imgbar\';'
  + 'var a=document.createElement(\'button\');a.type=\'button\';a.textContent=\'🖼\';a.title=\'Choose from gallery\';a.onclick=function(ev){ev.preventDefault();ev.stopPropagation();pick(false)};'
  + 'var c=document.createElement(\'button\');c.type=\'button\';c.textContent=\'📷\';c.title=\'Take photo\';c.onclick=function(ev){ev.preventDefault();ev.stopPropagation();pick(true)};'
  + 'b.appendChild(a);b.appendChild(c);document.body.appendChild(b)}'
  + 'if(document.readyState===\'loading\'){document.addEventListener(\'DOMContentLoaded\',boot)}else{boot()}'
  + '})()'
  + '</scr' + 'ipt>'

// Settings-panel injection script: strictly single-quoted; HTML attributes are
// also single-quoted to avoid escaping issues.
const PANEL_JS = '<scr' + 'ipt>'
  + '(function(){'
  + 'var KIND={auto:\'Auto\',phone:\'Phone\',desktop:\'Desktop\'};'
  + 'var STATE={running:\'Running\',starting:\'Starting\',stopped:\'Stopped\',error:\'Error\'};'
  + 'var pendingKinds={};'
  + 'var active=false;'
  + 'var timer=null;'
  + 'var optionsNode=null;'
  + 'var panelNode=null;'
  + 'var cell=null;'
  + 'function esc(s){return String(s==null?\'\':s).replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/\'/g,\'&#39;\').replace(/"/g,\'&quot;\')}'
  + 'function fmt(ms){return ms?new Date(ms).toLocaleString():\'\'}'
  + 'function kindBtns(cur,act,ip){'
  + 'var h=\'<span class="lg-muted">Access mode: </span>\';'
  + 'var ks=[\'auto\',\'phone\',\'desktop\'];'
  + 'for(var i=0;i<ks.length;i++){var k=ks[i];h+=\'<button class="lg-btn\'+(cur===k?\' lg-kind-on\':\'\')+\'" data-act="\'+act+\'" data-kind="\'+k+\'" data-ip="\'+ip+\'">\'+KIND[k]+\'</button>\'}'
  + 'return h}'
  + 'function post(action,ip,kind){'
  + 'fetch(\'/lan-gate/action\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({action:action,ip:ip||null,kind:kind||null})})'
  + '.then(function(){if(active)refresh()}).catch(function(){})}'
  + 'function refresh(){'
  + 'fetch(\'/lan-gate/status\').then(function(r){return r.json()}).then(render)'
  + '.catch(function(){if(panelNode)panelNode.innerHTML=\'<div class="lg-panel"><div class="lg-error">Could not read status (plugin may not be running)</div></div>\'})}'
  + 'function render(s){'
  + 'if(!panelNode)return;'
  + 'var pending=s.pending||[],approved=s.approved||[],denied=s.denied||[];'
  + 'var h=\'<div class="lg-head"><span class="lg-badge lg-badge-\'+esc(s.state)+\'">\'+(STATE[s.state]||s.state)+\'</span>\';'
  + 'h+=(s.state===\'running\'||s.state===\'starting\')?\'<button class="lg-btn" data-act="stop">Stop</button>\':\'<button class="lg-btn lg-btn-primary" data-act="restart">Start / Restart</button>\';'
  + 'h+=\'</div><div class="lg-muted">Port \'+esc(s.port)+\' · forwards to \'+esc(s.target)+\'</div>\';'
  + 'if(s.state===\'running\'){'
  + 'h+=\'<div class="lg-label">LAN access URLs (click to copy)</div>\';'
  + 'for(var i=0;i<(s.urls||[]).length;i++){h+=\'<div class="lg-url" data-copy="\'+esc(s.urls[i])+\'">\'+esc(s.urls[i])+\'</div>\'}}'
  + 'if(s.state===\'error\')h+=\'<div class="lg-error">Error: \'+esc(s.lastError||\'unknown\')+\'</div>\';'
  + 'if(pending.length){'
  + 'h+=\'<div class="lg-label">Pending devices (choose an access mode, then allow)</div>\';'
  + 'for(var j=0;j<pending.length;j++){var p=pending[j];var cur=pendingKinds[p.ip]||\'auto\';'
  + 'h+=\'<div class="lg-item"><div class="lg-ip">\'+esc(p.ip)+\'</div><div class="lg-muted lg-small">\'+esc(p.ua||\'\')+\'</div><div class="lg-row">\'+kindBtns(cur,\'kind\',p.ip)+\'</div><div class="lg-row"><button class="lg-btn lg-btn-primary" data-act="approve" data-ip="\'+esc(p.ip)+\'">Allow</button><button class="lg-btn lg-btn-danger" data-act="deny" data-ip="\'+esc(p.ip)+\'">Deny</button></div></div>\'}}'
  + 'if(approved.length){'
  + 'h+=\'<div class="lg-label">Approved devices (set an access mode per device)</div>\';'
  + 'for(var a=0;a<approved.length;a++){var d=approved[a];var dk=d.kind||\'auto\';'
  + 'h+=\'<div class="lg-item"><div class="lg-ip">\'+esc(d.ip)+\' · \'+(KIND[dk]||\'Auto\')+\'</div><div class="lg-muted lg-small">\'+fmt(d.at)+\'</div><div class="lg-row">\'+kindBtns(dk,\'set-kind\',d.ip)+\'</div><div class="lg-row"><button class="lg-btn" data-act="revoke" data-ip="\'+esc(d.ip)+\'">Revoke</button></div></div>\'}'
  + 'h+=\'<div class="lg-row"><button class="lg-btn lg-btn-danger" data-act="revoke-all">Revoke all</button></div>\'}'
  + 'if(denied.length){'
  + 'h+=\'<div class="lg-label">Denied devices</div>\';'
  + 'for(var b=0;b<denied.length;b++){var dn=denied[b];h+=\'<div class="lg-item"><div class="lg-ip">\'+esc(dn.ip)+\'</div><div class="lg-row"><button class="lg-btn lg-btn-primary" data-act="approve" data-ip="\'+esc(dn.ip)+\'">Allow again</button></div></div>\'}}'
  + 'h+=\'<div class="lg-muted">Note: only approved devices are forwarded to the local DSH; changing an access mode takes effect after that device refreshes.</div>\';'
  + 'panelNode.innerHTML=\'<div class="lg-panel">\'+h+\'</div>\'}'
  + 'function startPoll(){stopPoll();timer=setInterval(function(){if(active)refresh()},2000)}'
  + 'function stopPoll(){if(timer){clearInterval(timer);timer=null}}'
  + 'function styleActive(){'
  + 'var all=document.querySelectorAll(\'.lg-nav-cell\');'
  + 'for(var i=0;i<all.length;i++){if(all[i]===cell&&active){all[i].classList.add(\'lg-nav-active\')}else{all[i].classList.remove(\'lg-nav-active\')}}'
  + 'var listNode=cell?cell.parentNode:null;'
  + 'if(listNode){if(active){listNode.classList.add(\'lg-section-on\')}else{listNode.classList.remove(\'lg-section-on\')}}}'
  + 'function attach(){'
  + 'var dialog=document.querySelector(\'[role="dialog"][aria-modal="true"]\');'
  + 'if(!dialog||dialog.getAttribute(\'data-lg-attached\'))return;'
  + 'var nav=dialog.querySelector(\'nav\');'
  + 'if(!nav)return;'
  + 'var kids=nav.children;'
  + 'var list=kids.length>1?kids[kids.length-1]:null;'
  + 'if(!list)return;'
  + 'var contentNode=dialog.children[dialog.children.length-1];'
  + 'if(!contentNode)return;'
  + 'var opts=contentNode.children[contentNode.children.length-1];'
  + 'if(!opts)return;'
  + 'dialog.setAttribute(\'data-lg-attached\',\'1\');'
  + 'fetch(\'/lan-gate/status\').then(function(r){'
  + 'if(r.status===403)return;'
  + 'optionsNode=opts;'
  + 'panelNode=document.createElement(\'div\');'
  + 'panelNode.className=\'lg-nav-holder\';'
  + 'panelNode.style.display=\'none\';'
  + 'contentNode.appendChild(panelNode);'
  + 'panelNode.addEventListener(\'click\',function(ev){'
  + 'var el=ev.target;'
  + 'if(!el||!el.getAttribute)return;'
  + 'var copy=el.getAttribute(\'data-copy\');'
  + 'if(copy){try{if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(copy)}catch(e){}return}'
  + 'var act=el.getAttribute(\'data-act\');'
  + 'if(!act)return;'
  + 'var ip=el.getAttribute(\'data-ip\');'
  + 'var kind=el.getAttribute(\'data-kind\');'
  + 'if(act===\'kind\'){pendingKinds[ip]=kind;refresh();return}'
  + 'if(act===\'approve\'){post(\'approve\',ip,pendingKinds[ip]||\'auto\');return}'
  + 'if(act===\'deny\'){post(\'deny\',ip);return}'
  + 'if(act===\'set-kind\'){post(\'set-kind\',ip,kind);return}'
  + 'if(act===\'revoke\'){post(\'revoke\',ip);return}'
  + 'if(act===\'revoke-all\'){post(\'revoke-all\');return}'
  + 'if(act===\'stop\'){post(\'stop\');return}'
  + 'if(act===\'restart\'){post(\'restart\');return}'
  + '});'
  + 'cell=document.createElement(\'button\');'
  + 'cell.type=\'button\';'
  + 'cell.className=\'lg-nav-cell\';'
  + 'cell.setAttribute(\'data-lg-nav\',\'1\');'
  + 'cell.innerHTML=\'<span class="lg-nav-icon">🌐</span><span>LAN Access</span>\';'
  + 'cell.addEventListener(\'click\',function(ev){'
  + 'ev.stopPropagation();'
  + 'active=true;'
  + 'opts.style.display=\'none\';'
  + 'if(panelNode)panelNode.style.display=\'block\';'
  + 'styleActive();'
  + 'refresh();'
  + 'startPoll()});'
  + 'list.appendChild(cell);'
  + 'list.addEventListener(\'click\',function(ev){'
  + 'if(!ev.target.closest(\'[data-lg-nav]\')){active=false;stopPoll();opts.style.display=\'\';if(panelNode)panelNode.style.display=\'none\';styleActive()}}'
  + ',true)}).catch(function(){})}'
  + 'var mo=new MutationObserver(function(muts){'
  + 'for(var i=0;i<muts.length;i++){'
  + 'var nodes=muts[i].addedNodes;'
  + 'for(var j=0;j<nodes.length;j++){'
  + 'var n=nodes[j];'
  + 'if(n.nodeType===1&&(n.matches?n.matches(\'[role="dialog"][aria-modal="true"]\'):false)){attach();return}'
  + 'if(n.nodeType===1&&n.querySelector&&n.querySelector(\'[role="dialog"][aria-modal="true"]\')){attach();return}}}});'
  + 'mo.observe(document.body,{childList:true,subtree:true});'
  + 'attach();'
  + '})()'
  + '</scr' + 'ipt>'

function injectPanel(html) {
  if (typeof html !== 'string' || html === '') return html
  const headOpen = html.search(/<head[^>]*>/i)
  if (headOpen < 0) return html
  const headInsert = html.indexOf('>', headOpen) + 1
  const bodyOpen = html.search(/<body[^>]*>/i)
  if (bodyOpen < 0) return html
  const bodyInsert = html.indexOf('>', bodyOpen) + 1
  return html.slice(0, headInsert)
    + '<script>' + UUID_POLYFILL + '</script>' + DEVICE_CSS + PANEL_CSS
    + html.slice(headInsert, bodyInsert)
    + PANEL_JS
    + html.slice(bodyInsert)
}

// ---- local-only control routes (proxied devices carry x-forwarded-for; only local requests pass) ----

function isLocalRequest(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff !== 'string' || xff === '') return true
  const first = xff.split(',')[0].trim()
  if (isLoopbackIp(first)) return true
  return lanIps().indexOf(first) >= 0
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

// ---- control-route hardening: Origin check (CSRF defense; non-browser requests without an Origin header pass) ----

function isTrustedOrigin(req) {
  const origin = req.headers['origin']
  if (typeof origin !== 'string' || origin === '') return true
  try {
    const u = new URL(origin)
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return true
    if (lanIps().indexOf(u.hostname) >= 0) return true
    if (u.hostname.endsWith('.ts.net')) return true
    return false
  } catch (_err) {
    return false
  }
}

// ---- attachment upload: POST /lan-gate/upload?name=<filename>, body is raw bytes ----
// Files are saved to $DSH_HOME/uploads/<timestamp>-<safe-name>; 20MB per-file cap.
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024

function uploadHandler(req, res) {
  if (!isLocalRequest(req)) { json(res, 403, { ok: false, reason: 'forbidden' }); return }
  if (!isTrustedOrigin(req)) { json(res, 403, { ok: false, reason: 'bad-origin' }); return }
  if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'post-only' }); return }
  let rawName = 'file'
  try {
    const url = new URL(req.url, 'http://localhost')
    rawName = url.searchParams.get('name') || 'file'
  } catch (_err) { /* keep default name */ }
  const safe = String(rawName).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file'
  const dir = path.join(dshHome(), 'uploads')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {
    json(res, 500, { ok: false, reason: String(err && err.message ? err.message : err) })
    return
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(dir, ts + '-' + safe)
  let size = 0
  let aborted = false
  const ws = fs.createWriteStream(dest)
  req.on('data', (chunk) => {
    if (aborted) return
    size += chunk.length
    if (size > UPLOAD_MAX_BYTES) {
      aborted = true
      try { ws.destroy() } catch (_err) { /* destroyed */ }
      try { fs.unlinkSync(dest) } catch (_err) { /* file may not exist yet */ }
      json(res, 413, { ok: false, reason: 'too-large', maxBytes: UPLOAD_MAX_BYTES })
      return
    }
    ws.write(chunk)
  })
  req.on('end', () => {
    if (aborted) return
    ws.end(() => {
      json(res, 200, { ok: true, path: dest, name: safe, size })
    })
  })
  req.on('error', () => {
    if (!aborted) {
      try { ws.destroy() } catch (_err) { /* destroyed */ }
      try { fs.unlinkSync(dest) } catch (_err) { /* ignore */ }
    }
  })
}

// ---- plugin entry point ----

export function apply(ctx) {
  const webServer = ctx.webServer
  const decisions = loadDecisions()
  const seen = {}
  const live = new Map()
  const rateMap = new Map()

  let server = null
  let running = false
  let userStopped = false
  let lastError = ''
  let starting = false

  function save() {
    saveDecisions(decisions)
  }

  function decide(ip, allow, kind) {
    const prev = decisions[ip]
    const nextKind = kind === 'phone' || kind === 'desktop'
      ? kind
      : (prev && (prev.kind === 'phone' || prev.kind === 'desktop') ? prev.kind : 'auto')
    decisions[ip] = { ip: ip, allow: allow, at: Date.now(), revoked: false, kind: nextKind, token: randomToken(), issued: false }
    save()
  }

  function revokeIp(ip) {
    const prev = decisions[ip]
    decisions[ip] = { ip: ip, allow: prev ? prev.allow === true : true, at: Date.now(), revoked: true, kind: prev && prev.kind ? prev.kind : 'auto' }
    save()
  }

  function buildStatus() {
    const pending = []
    const approved = []
    const denied = []
    for (const ip of Object.keys(decisions)) {
      const d = decisions[ip]
      if (d.revoked === true) continue
      if (d.allow === true) approved.push({ ip: ip, at: d.at, kind: d.kind || 'auto' })
      else if (d.allow === false) denied.push({ ip: ip, at: d.at })
    }
    for (const ip of Object.keys(seen)) {
      const d = decisions[ip]
      if (d && d.revoked !== true) continue
      pending.push({ ip: ip, firstSeen: seen[ip].firstSeen, ua: seen[ip].ua })
    }
    const ips = lanIps()
    return {
      state: userStopped ? 'stopped' : running ? 'running' : starting ? 'starting' : 'error',
      port: PROXY_PORT,
      target: TARGET_HOST + ':' + TARGET_PORT,
      urls: ips.map((ip) => 'http://' + ip + ':' + PROXY_PORT),
      pending: pending,
      approved: approved,
      denied: denied,
      lastError: lastError,
    }
  }

  function statusHandler(req, res) {
    if (!isLocalRequest(req)) { json(res, 403, { ok: false, reason: 'forbidden' }); return }
    if (!isTrustedOrigin(req)) { json(res, 403, { ok: false, reason: 'bad-origin' }); return }
    json(res, 200, buildStatus())
  }

  function actionHandler(req, res) {
    if (!isLocalRequest(req)) { json(res, 403, { ok: false, reason: 'forbidden' }); return }
    if (!isTrustedOrigin(req)) { json(res, 403, { ok: false, reason: 'bad-origin' }); return }
    if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'post-only' }); return }
    const contentType = String(req.headers['content-type'] || '')
    if (contentType.indexOf('application/json') !== 0) { json(res, 415, { ok: false, reason: 'json-only' }); return }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      if (size < 16384) { size += chunk.length; chunks.push(chunk) }
    })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (_err) { json(res, 400, { ok: false }); return }
      const action = String(body.action || '')
      const ip = String(body.ip || '')
      const kind = String(body.kind || '')
      if (action === 'approve') decide(ip, true, kind)
      else if (action === 'deny') decide(ip, false, 'auto')
      else if (action === 'set-kind') { if (decisions[ip] && decisions[ip].allow === true && decisions[ip].revoked !== true) decide(ip, true, kind) }
      else if (action === 'revoke') revokeIp(ip)
      else if (action === 'revoke-all') { for (const key of Object.keys(decisions)) revokeIp(key) }
      else if (action === 'stop') {
        userStopped = true
        if (server) { try { server.close() } catch (_err) { /* closed */ } server = null }
        running = false
      } else if (action === 'restart') {
        userStopped = false
        lastError = ''
        if (server) { try { server.close() } catch (_err) { /* closed */ } server = null }
        running = false
        setTimeout(startProxy, 300)
      } else { json(res, 400, { ok: false }); return }
      json(res, 200, { ok: true })
    })
  }

  function overRate(ip) {
    const now = Date.now()
    let rate = rateMap.get(ip)
    if (!rate || now - rate.started >= 60000) { rate = { started: now, count: 0 }; rateMap.set(ip, rate) }
    rate.count += 1
    return rate.count > RATE_LIMIT_PER_MIN
  }

  // ---- real client IP resolution: Tailscale Serve (HTTPS entry) forwards
  // requests from the local machine and adds x-forwarded-for (the real client IP)
  // plus the tailscale-user-login identity header. Trust XFF only when the
  // connection actually comes from loopback AND carries the Serve header, so a
  // forged XFF on a direct external connection has no effect.
  function isServeRequest(req) {
    return req !== undefined && typeof req.headers['tailscale-user-login'] === 'string'
  }

  function clientIpFor(socket, req) {
    const remote = normalizeIp(socket.remoteAddress)
    if (socket.__proxiedIp && isLoopbackIp(remote)) return normalizeIp(socket.__proxiedIp)
    if (isLoopbackIp(remote) && isServeRequest(req)) {
      const xff = req.headers['x-forwarded-for']
      if (typeof xff === 'string' && xff !== '') return normalizeIp(xff.split(',')[0].trim())
    }
    return remote
  }

  function attachProxyProtocolParser(socket) {
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= 6 && buf.toString('ascii', 0, 6) === 'PROXY ') {
        const idx = buf.indexOf('\r\n')
        if (idx === -1) {
          if (buf.length > 107) { try { socket.destroy() } catch (_err) { /* destroyed */ } }
          return
        }
        const parts = buf.toString('ascii', 6, idx).split(' ')
        if (parts.length >= 2) socket.__proxiedIp = parts[1]
        socket.removeListener('data', onData)
        socket.unshift(buf.slice(idx + 2))
        return
      }
      if (buf.length >= 16 && buf[0] === 0x0d && buf[1] === 0x0a && buf[2] === 0x0d && buf[3] === 0x0a && buf[4] === 0x00 && buf[5] === 0x0d && buf[6] === 0x0a && buf[7] === 0x51 && buf[8] === 0x55 && buf[9] === 0x49 && buf[10] === 0x54 && buf[11] === 0x0a) {
        const fam = buf[12] === 0x21 ? buf.readUInt8(13) : 0
        const len = buf.readUInt16BE(14)
        const total = 16 + len
        if (buf.length < total) return
        let ip = ''
        if (fam === 0x11) {
          ip = buf[16] + '.' + buf[17] + '.' + buf[18] + '.' + buf[19]
        } else if (fam === 0x21) {
          const parts6 = []
          for (let k = 0; k < 8; k++) parts6.push(buf.readUInt16BE(16 + k * 2).toString(16))
          ip = parts6.join(':')
        }
        if (ip !== '') socket.__proxiedIp = ip
        socket.removeListener('data', onData)
        socket.unshift(buf.slice(total))
        return
      }
      // Not PROXY protocol: push the bytes back unchanged and let the HTTP parser continue
      socket.removeListener('data', onData)
      socket.unshift(buf)
    }
    socket.on('data', onData)
  }

  function startProxy() {
    if (server || userStopped) return
    starting = true
    const proxy = http.createServer((req, res) => {
      const ip = clientIpFor(req.socket, req)
      if (overRate(ip)) {
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' })
        res.end(rateLimitPage(ip))
        return
      }
      if (isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0) {
        forwardRequest(decisions, req, res, ip)
        return
      }
      const d = decisions[ip]
      if (isAllowed(decisions, ip)) {
        if (!d.token) { d.token = randomToken(); d.issued = false; save() }
        if (parseCookies(req).lg_token === d.token) {
          forwardRequest(decisions, req, res, ip)
          return
        }
        // The claim branch must precede "auto re-claim": /?t=token must be
        // claimed first, otherwise the claim request itself gets redirected back
        // to /?t=token, forming an infinite redirect loop.
        if (queryTicket(req.url) === d.token) {
          d.issued = true
          save()
          setTokenCookie(res, d.token, isServeRequest(req))
          res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' })
          res.end('')
          return
        }
        // Cookie self-heal: a browser on the same IP (same device) automatically
        // re-runs the claim redirect even if its cookie was cleared, or it
        // previously claimed through the other entry (3088/3443), instead of
        // getting stuck on the "bound to another browser" page. The token is
        // still only issued to the browser that follows the claim redirect.
        if (d.issued === true) {
          res.writeHead(302, { Location: '/?t=' + encodeURIComponent(d.token), 'Cache-Control': 'no-store' })
          res.end('')
          return
        }
        res.writeHead(302, { Location: '/?t=' + encodeURIComponent(d.token), 'Cache-Control': 'no-store' })
        res.end('')
        return
      }
      if (!seen[ip]) seen[ip] = { firstSeen: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 160) }
      if (d && d.allow === false && d.revoked !== true) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(deniedPage(ip))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(pendingPage(ip))
    })
    proxy.on('connection', (socket) => {
      attachProxyProtocolParser(socket)
    })
    proxy.on('upgrade', (req, socket, head) => {
      const ip = clientIpFor(socket, req)
      if (overRate(ip)) {
        try { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n') } catch (_err) { /* closed */ }
        return
      }
      const d = decisions[ip]
      const ok = isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0
        || (isAllowed(decisions, ip) && d !== undefined && d.token !== undefined && parseCookies(req).lg_token === d.token)
      if (!ok) {
        try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch (_err) { /* closed */ }
        return
      }
      const headers = cleanHeaders(req.headers, ip)
      headers['upgrade'] = req.headers['upgrade'] || 'websocket'
      headers['connection'] = 'Upgrade'
      const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
        let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n'
        for (const key of Object.keys(headers)) {
          const value = headers[key]
          if (Array.isArray(value)) {
            for (const v of value) raw += key + ': ' + v + '\r\n'
          } else {
            raw += key + ': ' + value + '\r\n'
          }
        }
        raw += '\r\n'
        let set = live.get(ip)
        if (!set) { set = new Set(); live.set(ip, set) }
        set.add(socket)
        set.add(upstream)
        const kill = () => {
          const s = live.get(ip)
          if (s) { s.delete(socket); s.delete(upstream); if (s.size === 0) live.delete(ip) }
          try { socket.destroy() } catch (_err) { /* destroyed */ }
          try { upstream.destroy() } catch (_err) { /* destroyed */ }
        }
        socket.on('error', kill)
        upstream.on('error', kill)
        socket.on('close', kill)
        upstream.on('close', kill)
        try { upstream.write(raw) } catch (_err) { /* closed */ }
        if (head && head.length > 0) { try { upstream.write(head) } catch (_err) { /* closed */ } }
        // Client direction: Serve (Go ReverseProxy) replays the HTTP request at
        // the start of the upgraded stream; when a block starting with an HTTP
        // method is detected, strip up to \r\n\r\n and forward only real WS frames.
        let clBuf = Buffer.alloc(0)
        let clStripped = false
        socket.on('data', (chunk) => {
          if (!clStripped) {
            clBuf = Buffer.concat([clBuf, chunk])
            const headAscii = clBuf.slice(0, 12).toString('ascii')
            if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH) /.test(headAscii)) {
              const idx = clBuf.indexOf('\r\n\r\n')
              if (idx === -1) {
                if (clBuf.length > 16384) { clStripped = true; clBuf = Buffer.alloc(0) }
                return
              }
              clBuf = clBuf.slice(idx + 4)
              clStripped = true
              if (clBuf.length > 0) upstream.write(clBuf)
              clBuf = Buffer.alloc(0)
              return
            }
            clStripped = true
            upstream.write(clBuf)
            clBuf = Buffer.alloc(0)
            return
          }
          upstream.write(chunk)
        })
        // Server direction: pass through
        upstream.on('data', (chunk) => {
          socket.write(chunk)
        })
      })
      upstream.on('error', () => { try { socket.destroy() } catch (_err) { /* destroyed */ } })
    })
    proxy.on('clientError', (_err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch (_err2) { /* closed */ }
    })
    proxy.on('error', (err) => {
      lastError = String(err && err.message ? err.message : err)
      starting = false
      running = false
      server = null
    })
    proxy.listen(PROXY_PORT, LISTEN_HOST, () => {
      running = true
      starting = false
      lastError = ''
      console.log('[lan-gate] listening on ' + LISTEN_HOST + ':' + PROXY_PORT + ' -> ' + TARGET_HOST + ':' + TARGET_PORT)
    })
    server = proxy
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: '/lan-gate/status', handler: statusHandler }), 'lan-gate: status route')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/lan-gate/action', handler: actionHandler }), 'lan-gate: action route')
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/lan-gate/upload', handler: uploadHandler }), 'lan-gate: upload route')
  ctx.effect(() => webServer.tapIndex(injectPanel), 'lan-gate: index injection')

  let lastUploadClean = 0
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [ip, rate] of rateMap) {
      if (now - rate.started >= 120000) rateMap.delete(ip)
    }
    for (const [ip, set] of live) {
      if (isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0 || isAllowed(decisions, ip)) continue
      for (const sock of set) { try { sock.destroy() } catch (_err) { /* destroyed */ } }
      live.delete(ip)
    }
    // Attachment-dir auto-cleanup: check hourly, delete files older than 7 days
    if (now - lastUploadClean > 3600 * 1000) {
      lastUploadClean = now
      try {
        const upDir = path.join(dshHome(), 'uploads')
        const cutoff = now - 7 * 24 * 3600 * 1000
        for (const name of fs.readdirSync(upDir)) {
          const p = path.join(upDir, name)
          try {
            const st = fs.statSync(p)
            if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p)
          } catch (_err) { /* ignore single-file delete failure */ }
        }
      } catch (_err) { /* dir missing or unreadable, ignore */ }
    }
  }, 3000)

  ctx.effect(() => {
    startProxy()
    return () => {
      clearInterval(sweep)
      userStopped = true
      const s = server
      server = null
      if (s) { try { s.close() } catch (_err) { /* closed */ } }
    }
  })
}
