/**
 * Local control panel for the DSH remote gateway.
 *
 * Mounted by server.mjs when a request targets /__ui or /__api. It is only
 * reachable with a loopback Host header, so tunnelled traffic can never touch
 * it: the panel can change the password, start/stop transports and read logs.
 *
 *   GET  /__ui, /__ui/*          static UI (gateway/ui/)
 *   GET  /__api/status           gateway + harness + tunnel state
 *   POST /__api/password         { password }
 *   POST /__api/tunnel           { action: 'start' | 'stop' }
 *   POST /__api/autostart        { enabled: boolean }
 *   GET  /__api/logs?lines=200   tail of gateway.log
 *
 * Transports: only the Cloudflare quick tunnel is offered here. Tailscale is
 * documented but not surfaced in the panel: on networks where both peers cannot
 * make a direct connection the traffic is relayed through DERP (often 300-500ms
 * with low throughput) and the ~1.7MB harness frontend never finishes loading.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(HERE, 'ui')
const REPO_ROOT = path.dirname(HERE)
const TUNNEL_URL_FILE = path.join(HERE, 'tunnel-url.txt')
const LOG_FILE = path.join(HERE, 'gateway.log')
const ACCESS_FILE = path.join(HERE, 'access.txt')

const MAX_BODY = 16 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

function findCloudflared() {
  const candidates = [
    path.join(REPO_ROOT, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    process.platform === 'win32' ? path.join(REPO_ROOT, 'bin', 'cloudflared.exe') : null,
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return 'cloudflared'
}

function findPython() {
  return process.platform === 'win32' ? 'python' : 'python3'
}

export function createControl({ cfg, configPath, log, readState, version }) {
  const tunnel = { child: null, url: null, starting: false, lastError: null }

  // ── helpers ────────────────────────────────────────────────────────────

  function isLoopbackHost(req) {
    const raw = String(req.headers.host || '').toLowerCase()
    const expected = [`127.0.0.1:${cfg.listenPort}`, `localhost:${cfg.listenPort}`, `[::1]:${cfg.listenPort}`]
    if (expected.includes(raw)) return true
    // Electron and password-less local dev may omit the port for default 80.
    return raw === '127.0.0.1' || raw === 'localhost'
  }

  function persistConfig() {
    const payload = { ...cfg }
    fs.writeFileSync(configPath, JSON.stringify(payload, null, 2) + '\n')
  }

  function hashPassword(password) {
    const salt = crypto.randomBytes(16)
    const hash = crypto.scryptSync(password, salt, 64)
    return `${salt.toString('hex')}:${hash.toString('hex')}`
  }

  function readAccessPassword() {
    try {
      for (const line of fs.readFileSync(ACCESS_FILE, 'utf8').split(/\r?\n/)) {
        if (line.startsWith('password:')) return line.slice('password:'.length).trim()
      }
    } catch {}
    return null
  }

  function writeAccessPassword(password) {
    try {
      fs.writeFileSync(ACCESS_FILE, `password: ${password}\ngenerated: ${new Date().toISOString()}\n`, { mode: 0o600 })
    } catch {}
  }

  function tunnelState() {
    let url = tunnel.url
    if (!url) {
      try {
        const saved = fs.readFileSync(TUNNEL_URL_FILE, 'utf8').trim()
        if (saved.startsWith('http')) url = saved
      } catch {}
    }
    const running = Boolean(tunnel.child && !tunnel.child.killed)
    return {
      running,
      // a saved URL with no managed process: started by scripts/refresh-tunnel.ps1
      external: Boolean(!running && url),
      url,
      starting: tunnel.starting,
      lastError: tunnel.lastError,
    }
  }

  function autostartState() {
    if (process.platform !== 'win32') return { supported: false, enabled: false }
    const target = path.join(
      process.env.APPDATA || '',
      'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\dsh-remote-gateway.vbs',
    )
    return { supported: true, enabled: fs.existsSync(target), path: target }
  }

  function tailLog(lines) {
    try {
      const content = fs.readFileSync(LOG_FILE, 'utf8')
      return content.split(/\r?\n/).slice(-Math.max(1, lines)).join('\n')
    } catch {
      return ''
    }
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload, null, 2)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  function readJson(req) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size <= MAX_BODY) chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  // ── transports ─────────────────────────────────────────────────────────

  function stopTunnel() {
    if (tunnel.child) {
      try { tunnel.child.kill() } catch {}
      tunnel.child = null
    }
    tunnel.url = null
    tunnel.lastError = null
    if (cfg.publicUrl) {
      cfg.publicUrl = ''
      try { persistConfig() } catch {}
    }
    try { fs.writeFileSync(TUNNEL_URL_FILE, '') } catch {}
    return { ok: true, running: false, url: null }
  }

  function startTunnel() {
    if (tunnel.child && !tunnel.child.killed) return Promise.resolve({ ok: true, running: true, url: tunnel.url })
    tunnel.starting = true
    tunnel.lastError = null
    const exe = findCloudflared()
    return new Promise((resolve) => {
      let settled = false
      let buffer = ''
      const child = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${cfg.listenPort}`, '--no-autoupdate'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      tunnel.child = child
      const finish = (payload) => {
        if (settled) return
        settled = true
        tunnel.starting = false
        resolve(payload)
      }
      const onLine = (line) => {
        const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line)
        if (match && !tunnel.url) {
          tunnel.url = match[0]
          cfg.publicUrl = tunnel.url
          try { persistConfig() } catch {}
          try { fs.writeFileSync(TUNNEL_URL_FILE, tunnel.url + '\n') } catch {}
          log('cloudflare tunnel started:', tunnel.url)
          finish({ ok: true, running: true, url: tunnel.url })
        }
      }
      const consume = (chunk) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) onLine(line)
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.on('error', (error) => {
        tunnel.child = null
        tunnel.lastError = error.message
        finish({ ok: false, running: false, error: `无法启动 cloudflared：${error.message}` })
      })
      child.on('exit', (code) => {
        tunnel.child = null
        tunnel.starting = false
        if (!tunnel.url) {
          tunnel.lastError = `cloudflared 退出（code ${code}）`
          finish({ ok: false, running: false, error: tunnel.lastError })
        } else {
          tunnel.url = null
        }
      })
      setTimeout(() => {
        if (!settled) {
          tunnel.lastError = '等待 cloudflared 分配地址超时'
          finish({ ok: false, running: true, url: null, error: tunnel.lastError })
        }
      }, 30000)
    })
  }

  // ── HTTP entry ─────────────────────────────────────────────────────────

  return {
    /** @returns {boolean} whether the request was handled */
    handle(req, res, url) {
      const isUi = url.pathname === '/__ui' || url.pathname.startsWith('/__ui/')
      const isApi = url.pathname === '/__api' || url.pathname.startsWith('/__api/')
      if (!isUi && !isApi) return false

      if (!isLoopbackHost(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('control panel is only available from this machine')
        return true
      }

      if (isUi) {
        if (url.pathname === '/__ui') {
          res.writeHead(301, { location: /__ui/ + (url.search || ''), 'cache-control': 'no-store' })
          res.end()
          return true
        }
        serveUi(res, url.pathname)
        return true
      }
      handleApi(req, res, url).catch((error) => {
        log('control panel error:', error?.message || error)
        if (!res.headersSent) json(res, 500, { ok: false, error: String(error?.message || error) })
      })
      return true
    },
    close() {
      stopTunnel()
    },
    tunnelSnapshot: tunnelState,
  }

  function serveUi(res, pathname) {
    let relative = pathname.replace(/^\/__ui\/?/, '') || 'index.html'
    if (relative.endsWith('/')) relative += 'index.html'
    const target = path.normalize(path.join(UI_DIR, relative))
    if (!target.startsWith(UI_DIR)) {
      res.writeHead(403); res.end('forbidden'); return
    }
    fs.readFile(target, (error, data) => {
      if (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(data)
    })
  }

  async function handleApi(req, res, url) {
    const route = url.pathname

    if (route === '/__api/status' && req.method === 'GET') {
      const state = readState()
      const autostart = autostartState()
      json(res, 200, {
        version,
        listen: `http://${cfg.listenHost}:${cfg.listenPort}`,
        publicUrl: cfg.publicUrl || '',
        harness: state
          ? { ok: true, port: state.port, exportedAt: state.exportedAt || null }
          : { ok: false, port: null, exportedAt: null },
        password: { set: Boolean(cfg.auth?.password) && cfg.auth?.mode !== 'none', value: readAccessPassword() },
        tunnel: tunnelState(),
        autostart,
        platform: process.platform,
      })
      return
    }

    if (route === '/__api/password' && req.method === 'POST') {
      const body = await readJson(req)
      const password = String(body.password || '')
      if (password.length < 8) { json(res, 400, { ok: false, error: '口令至少 8 位' }); return }
      cfg.auth = { mode: 'password', password: hashPassword(password) }
      persistConfig()
      writeAccessPassword(password)
      log('access password changed from the control panel')
      json(res, 200, { ok: true, value: password })
      return
    }

    if (route === '/__api/tunnel' && req.method === 'POST') {
      const body = await readJson(req)
      if (body.action === 'stop') { json(res, 200, stopTunnel()); return }
      const result = await startTunnel()
      json(res, result.ok ? 200 : 500, { ...result, tunnel: tunnelState() })
      return
    }

    if (route === '/__api/autostart' && req.method === 'POST') {
      const body = await readJson(req)
      const enabled = Boolean(body.enabled)
      if (process.platform !== 'win32') {
        json(res, 400, { ok: false, error: '当前系统暂不支持一键自启，请使用 systemd/launchd（见 README）' })
        return
      }
      const startupDir = path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs\\Startup')
      const target = path.join(startupDir, 'dsh-remote-gateway.vbs')
      try {
        if (enabled) {
          const source = path.join(REPO_ROOT, 'scripts', 'start-gateway.vbs')
          if (!fs.existsSync(source)) throw new Error('未找到 scripts/start-gateway.vbs')
          fs.copyFileSync(source, target)
        } else {
          fs.rmSync(target, { force: true })
        }
        json(res, 200, { ok: true, autostart: autostartState() })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error.message || error) })
      }
      return
    }

    if (route === '/__api/logs' && req.method === 'GET') {
      const lines = Number(url.searchParams.get('lines') || 200)
      const text = tailLog(Number.isFinite(lines) ? lines : 200)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text || '(log is empty)')
      return
    }

    json(res, 404, { ok: false, error: 'unknown endpoint' })
  }
}
