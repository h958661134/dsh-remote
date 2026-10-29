#!/usr/bin/env node
/**
 * DSH Remote Gateway
 *
 * Exposes the running DeepSeek Harness desktop host (bound to 127.0.0.1 only)
 * to a phone or another browser, over whatever transport fronts this listener
 * (Tailscale, Cloudflare Tunnel, ngrok, ...).
 *
 * How it works
 *   - The harness desktop app loads a tiny plugin (`remote-gw`) that writes the
 *     per-process launch URL (with its launch token) to `stateFile`.
 *   - This gateway exchanges that token for the harness browser-auth cookie and
 *     keeps it warm, then reverse-proxies HTTP + WebSocket traffic to
 *     `http://127.0.0.1:<port>` with `Host`/`Origin` rewritten back to loopback
 *     (so the harness browser-trust fence accepts the request).
 *   - Callers authenticate to the gateway itself with a password, and get a
 *     signed gateway session cookie. The harness cookie never leaves this
 *     process.
 *
 * Usage
 *   node server.mjs                 run the gateway
 *   node server.mjs --check         print config/state diagnostics and exit
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import os from 'node:os'
import { createControl } from './control.mjs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.DSHGW_CONFIG || path.join(HERE, 'config.json')
const VERSION = '0.1.0'
const SESSION_COOKIE = 'dshgw'
const LOGIN_PATH = '/__login'
const LOGOUT_PATH = '/__logout'
const HEALTH_PATH = '/__health'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function log (...args) {
  console.log(new Date().toISOString(), ...args)
}

function loadConfig () {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
  cfg.listenHost ??= '127.0.0.1'
  cfg.listenPort ??= 8787
  cfg.sessionMaxAgeDays ??= 30
  cfg.auth ??= { mode: 'password' }
  cfg.clientSupport ??= cfg.clientSupport ?? true
  cfg.stateFile ??= path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'remote-gw-state.json')
  return cfg
}

const HELP = `dsh-remote-gateway ${VERSION}

Expose the running DeepSeek Harness desktop app to a phone or another browser,
over Tailscale, a tunnel, or any reverse proxy.

Usage:
  node server.mjs                 run the gateway
  node server.mjs --check         print config/state diagnostics and exit
  node server.mjs --version       print the version
  node server.mjs --help          show this help

Config:
  ${CONFIG_PATH}
  env DSHGW_CONFIG=/path/to/config.json overrides the config file location.

The gateway listens on 127.0.0.1 by default. Put Tailscale or a tunnel in front
of it; never expose it to the LAN or the internet without the access password.
`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

let cfg = loadConfig()

// ───────────────────────────── harness state ─────────────────────────────

/** @returns {{port:number, launchUrl:string, authority:string, mtimeMs:number}|null} */
function readState () {
  try {
    const stat = fs.statSync(cfg.stateFile)
    if (!stat.size) return null
    const raw = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'))
    if (!raw || typeof raw.port !== 'number' || typeof raw.launchUrl !== 'string') return null
    return {
      port: raw.port,
      launchUrl: raw.launchUrl,
      authority: `127.0.0.1:${raw.port}`,
      mtimeMs: stat.mtimeMs,
    }
  } catch {
    return null
  }
}

// ───────────────────────── upstream plumbing ─────────────────────────────

const authCache = { authority: null, cookie: null, at: 0 }

function upstreamCall (state, { method = 'GET', path: reqPath = '/', headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: state.port,
      method,
      path: reqPath,
      headers: { ...headers, host: state.authority },
      agent: false,
      timeout,
    })
    req.on('timeout', () => req.destroy(new Error('harness timeout')))
    req.on('error', reject)
    req.on('response', (res) => resolve({ req, res }))
    req.end()
  })
}

function setCookies (res) {
  const raw = res.headers['set-cookie']
  if (!raw) return []
  return (Array.isArray(raw) ? raw : [raw]).map((c) => String(c).split(';')[0])
}

async function fetchAuthCookie (state, { force = false } = {}) {
  const fresh = authCache.cookie &&
    authCache.authority === state.authority &&
    Date.now() - authCache.at < 5 * 60 * 1000
  if (fresh && !force) return authCache.cookie

  const url = new URL(state.launchUrl)
  const { res } = await upstreamCall(state, {
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: { accept: 'text/html' },
  })
  const found = setCookies(res).find((c) => c.startsWith('dsh-auth-'))
  res.resume()
  if (!found) throw new Error(`launch token exchange returned no dsh-auth cookie (HTTP ${res.statusCode})`)
  authCache.authority = state.authority
  authCache.cookie = found
  authCache.at = Date.now()
  log('harness auth cookie refreshed for', state.authority)
  return found
}

// ───────────────────────── gateway session ───────────────────────────────

function hmac (value) {
  return crypto.createHmac('sha256', cfg.sessionSecret).update(value).digest('base64url')
}

function safeEqual (a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

function issueSession () {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + cfg.sessionMaxAgeDays * 86400000 })).toString('base64url')
  return `${payload}.${hmac(payload)}`
}

function verifySession (value) {
  if (!value) return false
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return false
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  if (!safeEqual(sig, hmac(payload))) return false
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof parsed.exp === 'number' && parsed.exp > Date.now()
  } catch {
    return false
  }
}

function parseCookies (req) {
  const out = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

function passwordOk (input) {
  const stored = cfg.auth?.password
  if (!stored) return cfg.auth?.mode === 'none'
  const [saltHex, hashHex] = String(stored).split(':')
  if (!saltHex || !hashHex) return false
  const computed = crypto.scryptSync(String(input), Buffer.from(saltHex, 'hex'), 64).toString('hex')
  return safeEqual(computed, hashHex)
}

const loginFailures = new Map() // ip -> { count, resetAt }

function throttled (ip) {
  const entry = loginFailures.get(ip)
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= 10)
}

function noteFailure (ip) {
  const now = Date.now()
  const entry = loginFailures.get(ip)
  if (!entry || entry.resetAt <= now) loginFailures.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 })
  else entry.count += 1
}

function isAuthed (req) {
  if (cfg.auth?.mode === 'none') return true
  return verifySession(parseCookies(req)[SESSION_COOKIE])
}

function clientIp (req) {
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

function sessionCookieHeader () {
  const secure = Boolean(cfg.publicUrl && cfg.publicUrl.startsWith('https://'))
  const parts = [
    `${SESSION_COOKIE}=${issueSession()}`,
    'Path=/',
    `Max-Age=${cfg.sessionMaxAgeDays * 86400}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function clearCookieHeader () {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}

// ───────────────────────────── HTML pages ────────────────────────────────

const STYLE = `
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 16px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #0f1115; color: #e6e8ee; padding: 24px; }
  .card { width: 100%; max-width: 420px; min-width: 0; background: #171a21; border: 1px solid #262b36;
    border-radius: 16px; padding: 28px 24px; box-shadow: 0 24px 60px rgba(0,0,0,.45); }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p.sub { margin: 0 0 22px; color: #8b93a7; font-size: 14px; }
  label { display: block; font-size: 13px; color: #9aa3b7; margin-bottom: 8px; }
  input[type=password] { width: 100%; padding: 13px 14px; font-size: 16px; border-radius: 10px;
    border: 1px solid #2c3341; background: #0f1218; color: #e6e8ee; }
  input[type=password]:focus { outline: none; border-color: #4c7dff; }
  button { width: 100%; margin-top: 18px; padding: 13px 14px; font-size: 16px; font-weight: 600;
    border: 0; border-radius: 10px; background: #4c7dff; color: #fff; }
  button:active { transform: translateY(1px); }
  .err { color: #ff7d7d; font-size: 14px; margin-top: 14px; }
  .meta { margin-top: 18px; color: #6d7688; font-size: 12px; }
  code { background: #0f1218; padding: 2px 6px; border-radius: 6px; }
`

function page (title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}

function loginPage (error) {
  return page('DSH 远程访问', `
  <form class="card" method="post" action="${LOGIN_PATH}">
    <h1>DeepSeek Harness</h1>
    <p class="sub">远程访问需要口令验证</p>
    <label for="pw">访问口令</label>
    <input id="pw" name="password" type="password" autocomplete="current-password"
      inputmode="text" autofocus required>
    <button type="submit">进入 Harness</button>
    ${error ? `<div class="err">${error}</div>` : ''}
    <div class="meta">口令错误 10 次将锁定该 IP 10 分钟。</div>
  </form>`)
}

function offlinePage (detail) {
  return page('Harness 未运行', `
  <div class="card">
    <h1>Harness 未运行</h1>
    <p class="sub">桌面版 DeepSeek Harness 当前没有启动，远程网关暂时无后端可转发。</p>
    <div class="meta">请在电脑上打开 DeepSeek Harness 后刷新本页。</div>
    ${detail ? `<div class="meta">诊断：<code>${String(detail).slice(0, 300)}</code></div>` : ''}
  </div>`)
}

// ───────────────────────── client compatibility layer ────────────────────

const REPORT_PATH = '/__report'
const COMPAT_VERSION = '2'

// Injected before every app script. Fills APIs that Chromium 115 (OPPO
// HeyTapBrowser and other China-market WebViews) is missing, and reports
// client-side exceptions back to this gateway.
const CLIENT_SUPPORT = `<script>/* dsh-remote-gateway compat ${COMPAT_VERSION} */
(function(){
  var g = window;
  function def(target, name, value) {
    try {
      Object.defineProperty(target, name, { value: value, writable: true, configurable: true, enumerable: false });
    } catch (e) {
      try { target[name] = value; } catch (e2) {}
    }
  }

  // Promise.withResolvers — Chromium 119+
  if (typeof Promise.withResolvers !== 'function') {
    def(Promise, 'withResolvers', function () {
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    });
  }

  // Array.fromAsync — Chromium 121+
  if (typeof Array.fromAsync !== 'function') {
    def(Array, 'fromAsync', async function (items, mapFn, thisArg) {
      var out = [];
      if (items != null && typeof items[Symbol.asyncIterator] === 'function') {
        for await (var value of items) {
          out.push(mapFn ? await mapFn.call(thisArg, value, out.length) : value);
        }
        return out;
      }
      var index = 0;
      for (var item of items) {
        out.push(mapFn ? await mapFn.call(thisArg, item, index++) : item);
      }
      return out;
    });
  }

  // Change-array-by-copy — Chromium 110+
  if (typeof Array.prototype.toSorted !== 'function') {
    def(Array.prototype, 'toSorted', function (compare) { return this.slice().sort(compare); });
  }
  if (typeof Array.prototype.toReversed !== 'function') {
    def(Array.prototype, 'toReversed', function () { return this.slice().reverse(); });
  }
  if (typeof Array.prototype.toSpliced !== 'function') {
    def(Array.prototype, 'toSpliced', function () {
      var copy = this.slice();
      copy.splice.apply(copy, arguments);
      return copy;
    });
  }
  if (typeof Array.prototype.with !== 'function') {
    def(Array.prototype, 'with', function (index, value) {
      var copy = this.slice();
      var i = index < 0 ? copy.length + index : index;
      if (i < 0 || i >= copy.length) throw new RangeError('Invalid index');
      copy[i] = value;
      return copy;
    });
  }
  if (typeof Array.prototype.findLast !== 'function') {
    def(Array.prototype, 'findLast', function (fn, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i];
      return undefined;
    });
  }
  if (typeof Array.prototype.findLastIndex !== 'function') {
    def(Array.prototype, 'findLastIndex', function (fn, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i;
      return -1;
    });
  }

  // Object.groupBy / Map.groupBy — Chromium 117+
  function groupBy(recipe, asMap) {
    return function (items, callback, thisArg) {
      var out = asMap ? new Map() : Object.create(null);
      var index = 0;
      for (var item of items) {
        var key = callback.call(thisArg, item, index++);
        if (asMap) {
          var bucket = out.get(key);
          if (!bucket) { bucket = []; out.set(key, bucket); }
          bucket.push(item);
        } else {
          var k = typeof key === 'string' ? key : String(key);
          if (!out[k]) out[k] = [];
          out[k].push(item);
        }
      }
      return out;
    };
  }
  if (typeof Object.groupBy !== 'function') def(Object, 'groupBy', groupBy('groupBy', false));
  if (typeof Map.groupBy !== 'function') def(Map, 'groupBy', groupBy('groupBy', true));

  // Set methods — Chromium 122+
  if (typeof Set.prototype.union !== 'function') {
    def(Set.prototype, 'union', function (other) { var out = new Set(this); for (var v of other) out.add(v); return out; });
  }
  if (typeof Set.prototype.intersection !== 'function') {
    def(Set.prototype, 'intersection', function (other) {
      var out = new Set();
      var probe = other instanceof Set ? other : new Set(other);
      for (var v of this) if (probe.has(v)) out.add(v);
      return out;
    });
  }
  if (typeof Set.prototype.difference !== 'function') {
    def(Set.prototype, 'difference', function (other) {
      var out = new Set(this);
      for (var v of other) out.delete(v);
      return out;
    });
  }
  if (typeof Set.prototype.symmetricDifference !== 'function') {
    def(Set.prototype, 'symmetricDifference', function (other) {
      var out = new Set(this);
      for (var v of other) { if (this.has(v)) out.delete(v); else out.add(v); }
      return out;
    });
  }
  if (typeof Set.prototype.isSubsetOf !== 'function') {
    def(Set.prototype, 'isSubsetOf', function (other) {
      var probe = other instanceof Set ? other : new Set(other);
      for (var v of this) if (!probe.has(v)) return false;
      return true;
    });
  }
  if (typeof Set.prototype.isSupersetOf !== 'function') {
    def(Set.prototype, 'isSupersetOf', function (other) {
      for (var v of other) if (!this.has(v)) return false;
      return true;
    });
  }
  if (typeof Set.prototype.isDisjointFrom !== 'function') {
    def(Set.prototype, 'isDisjointFrom', function (other) {
      for (var v of other) if (this.has(v)) return false;
      return true;
    });
  }

  // URL.canParse / URL.parse — Chromium 120+
  if (typeof URL.canParse !== 'function') {
    def(URL, 'canParse', function (input, base) {
      try { new URL(input, base); return true; } catch (e) { return false; }
    });
  }

  // AbortSignal.any — Chromium 116+
  if (typeof AbortSignal.any !== 'function') {
    def(AbortSignal, 'any', function (signals) {
      var controller = new AbortController();
      var list = Array.from(signals);
      for (var signal of list) {
        if (signal.aborted) { controller.abort(signal.reason); return controller.signal; }
        signal.addEventListener('abort', function () { controller.abort(signal.reason); }, { once: true });
      }
      return controller.signal;
    });
  }

  // String trimming — Chromium 111+
  if (typeof String.prototype.isWellFormed !== 'function') {
    def(String.prototype, 'isWellFormed', function () {
      try { return this.toWellFormed ? this.toWellFormed() === String(this) : true; } catch (e) { return true; }
    });
  }

  // crypto.randomUUID needs a secure context; this origin is plain http.
  try {
    if (typeof crypto.randomUUID !== 'function') {
      def(crypto, 'randomUUID', function () {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        var hex = [];
        for (var i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
        return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') +
          '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
      });
    }
  } catch (e) {}

  // navigator.clipboard also needs a secure context.
  try {
    if (!navigator.clipboard) {
      def(navigator, 'clipboard', {
        writeText: function (text) {
          return new Promise(function (resolve, reject) {
            try {
              var area = document.createElement('textarea');
              area.value = String(text);
              area.setAttribute('readonly', '');
              area.style.position = 'fixed';
              area.style.opacity = '0';
              document.body.appendChild(area);
              area.select();
              var ok = document.execCommand('copy');
              area.remove();
              ok ? resolve() : reject(new Error('copy failed'));
            } catch (error) { reject(error); }
          });
        },
        readText: function () { return Promise.reject(new Error('clipboard.readText unavailable')); }
      });
    }
  } catch (e) {}

  g.__DSHGW_COMPAT__ = '${COMPAT_VERSION}';

  // ---- client diagnostics ----
  try {
    var sent = 0;
    var send = function (kind, payload) {
      if (sent > 500) return;
      sent += 1;
      try {
        fetch(${JSON.stringify(REPORT_PATH)}, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: kind, payload: payload, ua: navigator.userAgent, url: location.href, secure: window.isSecureContext, compat: '${COMPAT_VERSION}', at: Date.now() })
        }).catch(function () {});
      } catch (e) {}
    };
    g.__DSHGW_REPORT__ = send;

    window.addEventListener('error', function (event) {
      var target = event.target;
      if (target && (target.src || target.href)) {
        send('resource-error', { tag: target.tagName, url: String(target.src || target.href), message: event.message });
        return;
      }
      send('error', { message: event.message, file: event.filename, line: event.lineno, col: event.colno, stack: event.error && event.error.stack });
    }, true);

    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      send('rejection', { message: String(reason && reason.message || reason), stack: reason && reason.stack });
    });

    ['error', 'warn', 'log'].forEach(function (level) {
      var original = console[level];
      console[level] = function () {
        try {
          send('console', { level: level, args: Array.prototype.slice.call(arguments).map(function (a) {
            try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (x) { return String(a); }
          }).join(' ') });
        } catch (e) {}
        return original.apply(console, arguments);
      };
    });

    var diag = function (label) {
      try {
        var root = document.getElementById('root') || document.body;
        var resources = (performance.getEntriesByType('resource') || [])
          .filter(function (entry) { return /plugins|assets|__report/.test(entry.name); })
          .slice(-40)
          .map(function (entry) {
            return {
              u: entry.name.replace(location.origin, ''),
              d: Math.round(entry.duration),
              s: entry.transferSize || 0,
              t: entry.initiatorType,
            };
          });
        var scripts = Array.prototype.map.call(document.scripts, function (script) {
          return script.src ? script.src.replace(location.origin, '') : 'inline';
        });
        send('diag', {
          label: label,
          readyState: document.readyState,
          bootReady: Boolean(globalThis.__DSH_BOOT_READY__),
          moduleLoaderMode: g.__ModuleLoader__ && g.__ModuleLoader__.mode,
          pendingQueue: g.__ModuleLoader__ && g.__ModuleLoader__.pendingQueue && g.__ModuleLoader__.pendingQueue.length,
          rootChildren: root.children.length,
          rootHtmlLen: root.innerHTML.length,
          scripts: scripts.slice(0, 30),
          resources: resources,
          elapsed: Math.round(performance.now()),
        });
      } catch (e) {}
    };
    setTimeout(function () { diag('5s') }, 5000);
    setTimeout(function () { diag('12s') }, 12000);
    setTimeout(function () { diag('20s') }, 20000);

    send('boot', { readyState: document.readyState });
  } catch (e) {}
})();</script>`

function injectClientSupport (html) {
  if (!cfg.clientSupport) return html
  if (html.includes('dsh-remote-gateway compat')) return html
  const head = html.search(/<head[^>]*>/i)
  if (head >= 0) {
    const end = html.indexOf('>', head) + 1
    return html.slice(0, end) + CLIENT_SUPPORT + html.slice(end)
  }
  const body = html.search(/<body[^>]*>/i)
  if (body >= 0) {
    const end = html.indexOf('>', body) + 1
    return html.slice(0, end) + CLIENT_SUPPORT + html.slice(end)
  }
  return CLIENT_SUPPORT + html
}

function bufferHtml (upstream, res, { inject }) {
  const chunks = []
  upstream.on('data', (chunk) => chunks.push(chunk))
  upstream.on('end', () => {
    let raw = Buffer.concat(chunks)
    const encoding = String(upstream.headers['content-encoding'] || '').toLowerCase()
    try {
      if (encoding === 'gzip') raw = zlib.gunzipSync(raw)
      else if (encoding === 'br') raw = zlib.brotliDecompressSync(raw)
      else if (encoding === 'deflate') raw = zlib.inflateSync(raw)
    } catch (error) {
      log('failed to decode html response:', error.message)
    }
    let body = raw.toString('utf8')
    if (inject) body = injectClientSupport(body)
    const headers = {}
    for (const [key, value] of Object.entries(upstream.headers)) {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (['content-length', 'content-encoding', 'etag'].includes(lower)) continue
      headers[key] = value
    }
    if (headers['set-cookie']) {
      const kept = (Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']])
        .filter((c) => !String(c).startsWith('dsh-auth-'))
      if (kept.length) headers['set-cookie'] = kept
      else delete headers['set-cookie']
    }
    const payload = Buffer.from(body, 'utf8')
    headers['content-length'] = String(payload.length)
    headers['cache-control'] = 'no-store'
    res.writeHead(upstream.statusCode || 502, upstream.statusMessage, headers)
    res.end(payload)
  })
  upstream.on('error', () => res.destroy())
}

// ───────────────────────────── proxying ──────────────────────────────────

function buildUpstreamHeaders (req, state, cookie) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'referer') continue
    headers[lower] = value
  }
  headers.host = state.authority
  headers.cookie = cookie
  if (cfg.clientSupport && String(req.headers.accept || '').includes('text/html')) {
    delete headers['accept-encoding']
  }
  if (req.headers.origin) headers.origin = `http://${state.authority}`
  if (req.headers.referer) {
    try {
      const ref = new URL(req.headers.referer)
      headers.referer = `http://${state.authority}${ref.pathname}${ref.search}`
    } catch { /* keep original */ }
  }
  return headers
}

function writeProxiedResponse (upstream, res) {
  const headers = {}
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    headers[key] = value
  }
  if (headers['set-cookie']) {
    const kept = (Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']])
      .filter((c) => !String(c).startsWith('dsh-auth-'))
    if (kept.length) headers['set-cookie'] = kept
    else delete headers['set-cookie']
  }
  res.writeHead(upstream.statusCode || 502, upstream.statusMessage, headers)
  upstream.pipe(res)
  upstream.on('error', () => res.destroy())
}

const MAX_BUFFERED_BODY = 16 * 1024 * 1024

function readRequestBodyBuffer (req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let finished = false
    req.on('data', (chunk) => {
      if (finished) return
      size += chunk.length
      if (size > limit) {
        finished = true
        reject(new Error('request body too large to buffer'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', (error) => { if (!finished) { finished = true; reject(error) } })
  })
}

/**
 * Forward one request to the harness. `body` is a Buffer when the body was
 * buffered (retryable), or undefined when it must be streamed through.
 */
function forwardUpstream (state, req, cookie, body) {
  const headers = buildUpstreamHeaders(req, state, cookie)
  if (Buffer.isBuffer(body)) headers['content-length'] = String(body.length)
  const upstreamReq = http.request({
    host: '127.0.0.1',
    port: state.port,
    method: req.method,
    path: req.url,
    headers,
    agent: false,
    timeout: 30000,
  })
  const response = new Promise((resolve, reject) => {
    upstreamReq.on('response', resolve)
    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('harness timeout')))
    upstreamReq.on('error', reject)
  })
  if (Buffer.isBuffer(body)) upstreamReq.end(body)
  else if (req.method === 'GET' || req.method === 'HEAD') upstreamReq.end()
  else req.pipe(upstreamReq)
  return response
}

async function handleProxy (req, res) {
  const state = readState()
  if (!state) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(offlinePage('state file missing or unreadable: ' + cfg.stateFile))
    return
  }

  let cookie
  try {
    cookie = await fetchAuthCookie(state)
  } catch (error) {
    log('auth bootstrap failed:', error.message)
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(offlinePage(error.message))
    return
  }

  const bodyless = req.method === 'GET' || req.method === 'HEAD'
  const declaredLength = req.headers['content-length']
  let body
  if (bodyless) {
    body = Buffer.alloc(0)
  } else if (declaredLength !== undefined && Number(declaredLength) <= MAX_BUFFERED_BODY) {
    try {
      body = await readRequestBodyBuffer(req, MAX_BUFFERED_BODY)
    } catch (error) {
      log('failed to read request body:', error.message)
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('request body too large')
      return
    }
  } else {
    body = undefined // stream through, no retry possible
  }

  let upstream
  try {
    upstream = await forwardUpstream(state, req, cookie, body)
  } catch (error) {
    log('upstream request failed:', error.message)
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(offlinePage(error.message))
    return
  }

  if (upstream.statusCode === 401 && Buffer.isBuffer(body)) {
    upstream.resume()
    log('upstream answered 401; refreshing harness cookie and retrying once')
    try {
      cookie = await fetchAuthCookie(state, { force: true })
      upstream = await forwardUpstream(state, req, cookie, body)
    } catch (error) {
      log('cookie refresh retry failed:', error.message)
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(offlinePage('harness rejected the gateway credential'))
      return
    }
  }

  const upstreamType = String(upstream.headers['content-type'] || '')
  if (cfg.clientSupport && upstreamType.includes('text/html')) {
    bufferHtml(upstream, res, { inject: true })
    return
  }
  writeProxiedResponse(upstream, res)
}

async function handleUpgrade (req, socket, head) {
  socket.on('error', () => {})
  const ua = String(req.headers['user-agent'] || '-').slice(0, 90)
  log(`UPGRADE ${req.url} ua="${ua}" authed=${isAuthed(req)}`)
  if (!isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  const state = readState()
  if (!state) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  let cookie
  try {
    cookie = await fetchAuthCookie(state)
  } catch {
    socket.destroy()
    return
  }

  const lines = [`GET ${req.url} HTTP/1.1`]
  const skip = new Set(['connection', 'upgrade', 'host', 'origin', 'cookie', 'proxy-connection', 'keep-alive'])
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (skip.has(lower)) continue
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`)
  }
  lines.push(`Host: ${state.authority}`)
  if (req.headers.origin) lines.push(`Origin: http://${state.authority}`)
  lines.push(`Cookie: ${cookie}`)
  lines.push('Connection: Upgrade')
  lines.push(`Upgrade: ${req.headers.upgrade || 'websocket'}`)

  const upstream = net.connect(state.port, '127.0.0.1', () => {
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
}

// ─────────────────────────────── server ──────────────────────────────────

function readBody (req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

const control = createControl({ cfg, configPath: CONFIG_PATH, log, readState, version: VERSION })

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now()
  res.on('finish', () => {
    try {
      const ua = String(req.headers['user-agent'] || '-').slice(0, 90)
      log(`${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - startedAt}ms ua="${ua}"`)
    } catch {}
  })
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'gateway'}`)
    if (control.handle(req, res, url)) return

    if (url.pathname === LOGIN_PATH) {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(loginPage(''))
        return
      }
      const ip = clientIp(req)
      if (throttled(ip)) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(loginPage('尝试过于频繁，请稍后再试。'))
        return
      }
      const body = await readBody(req)
      const password = new URLSearchParams(body).get('password') || ''
      if (!passwordOk(password)) {
        noteFailure(ip)
        log('login failed from', ip)
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(loginPage('口令不正确。'))
        return
      }
      loginFailures.delete(ip)
      log('login ok from', ip)
      res.writeHead(303, { 'set-cookie': sessionCookieHeader(), location: './', 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (url.pathname === REPORT_PATH && req.method === 'POST') {
      const body = await readBody(req, 256 * 1024)
      log('CLIENT-REPORT', clientIp(req), body.slice(0, 6000))
      res.writeHead(204, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      res.end()
      return
    }

    if (url.pathname === LOGOUT_PATH) {
      res.writeHead(303, { 'set-cookie': clearCookieHeader(), location: LOGIN_PATH, 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (url.pathname === HEALTH_PATH) {
      const state = readState()
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      res.end(JSON.stringify({
        ok: Boolean(state),
        harnessPort: state?.port ?? null,
        harnessStateAgeMs: state ? Date.now() - state.mtimeMs : null,
        authed: isAuthed(req),
        authMode: cfg.auth?.mode ?? 'password',
        publicUrl: cfg.publicUrl || null,
        upstreamCookieAgeMs: authCache.cookie ? Date.now() - authCache.at : null,
      }, null, 2))
      return
    }

    if (!isAuthed(req)) {
      const wantsHtml = String(req.headers.accept || '').includes('text/html')
      if (!wantsHtml && req.method !== 'GET') {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      res.writeHead(303, { location: LOGIN_PATH, 'cache-control': 'no-store' })
      res.end()
      return
    }

    await handleProxy(req, res)
  } catch (error) {
    log('request failed:', error?.stack || error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('gateway error')
    } else {
      res.destroy()
    }
  }
})

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head).catch(() => socket.destroy())
})

server.on('clientError', (_error, socket) => {
  try { socket.destroy() } catch {}
})

if (process.argv.includes('--check')) {
  const state = readState()
  console.log(JSON.stringify({
    configFile: CONFIG_PATH,
    listen: `${cfg.listenHost}:${cfg.listenPort}`,
    stateFile: cfg.stateFile,
    state: state && { ...state, launchUrl: String(state.launchUrl).replace(/([?&]token=)[^&]+/, '\<redacted>') },
    authMode: cfg.auth?.mode,
    hasPassword: Boolean(cfg.auth?.password),
    publicUrl: cfg.publicUrl || null,
  }, null, 2))
  process.exit(0)
}

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    log(`port ${cfg.listenPort} already in use — another gateway instance is probably running; exiting`)
    process.exit(0)
  }
  log('server error:', error?.message || error)
  process.exit(1)
})

server.listen(cfg.listenPort, cfg.listenHost, () => {
log(`dsh-remote-gateway v${VERSION} listening on http://${cfg.listenHost}:${cfg.listenPort}`)
  log(`state file: ${cfg.stateFile}`)
  const state = readState()
  log(state ? `harness detected on port ${state.port}` : 'harness state not found yet (is the desktop app running?)')
})
