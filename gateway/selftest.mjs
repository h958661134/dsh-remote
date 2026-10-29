#!/usr/bin/env node
/**
 * Self-test for the DSH Remote Gateway: login, index, assets, and the
 * /api/remote.mux WebSocket upgrade. Works for http and https base URLs.
 *
 *   node selftest.mjs <password> [baseUrl]
 */

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'

const password = process.argv[2] || process.env.DSHGW_PASSWORD || ''
const base = new URL(process.argv[3] || 'http://127.0.0.1:8787')
const secure = base.protocol === 'https:'
const client = secure ? https : http
const port = base.port || (secure ? 443 : 80)
const origin = `${base.protocol}//${base.host}`

if (!password) {
  console.error('usage: node selftest.mjs <password> [baseUrl]')
  process.exit(2)
}

function request (path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = client.request({
      host: base.hostname,
      port,
      method,
      path,
      headers,
      agent: false,
      timeout: 25000,
      servername: secure ? base.hostname : undefined,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error(`timeout: ${method} ${path}`)))
    req.on('error', reject)
    if (body) req.end(body)
    else req.end()
  })
}

function upgrade (path, headers) {
  return new Promise((resolve) => {
    const req = client.request({
      host: base.hostname,
      port,
      path,
      headers,
      agent: false,
      timeout: 25000,
      servername: secure ? base.hostname : undefined,
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode, headers: res.headers })
    })
    req.on('response', (res) => {
      res.resume()
      resolve({ status: res.statusCode, headers: res.headers })
    })
    req.on('timeout', () => req.destroy(new Error('upgrade timeout')))
    req.on('error', (error) => resolve({ status: 0, error: error.message }))
    req.end()
  })
}

const results = []
function check (name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}

const loginBody = `password=${encodeURIComponent(password)}`
const login = await request('/__login', {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': Buffer.byteLength(loginBody),
  },
  body: loginBody,
})
check('login accepts correct password', login.status === 303, `status ${login.status}`)

const setCookie = login.headers['set-cookie'] || []
const session = String(setCookie[0] || '').split(';')[0]
check('login sets gateway session cookie', session.startsWith('dshgw='), session ? 'cookie present' : 'no cookie')

const wrong = await request('/__login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'password=definitely-wrong',
})
check('login rejects wrong password', wrong.status === 401, `status ${wrong.status}`)

const anonymous = await request('/')
check('anonymous request redirects to login', anonymous.status === 303 && anonymous.headers.location === '/__login')

const index = await request('/', { headers: { cookie: session } })
const html = index.body.toString('utf8')
check('index served through gateway', index.status === 200 && html.includes('__DSH_BOOT__'), `${index.status}, ${html.length} bytes`)

const assetPaths = [...html.matchAll(/(?:src|href)="((?:\.\/|\/)[^"]+\.(?:js|css|json))"/g)].map((m) => m[1])
const uniqueAssets = [...new Set(assetPaths)].slice(0, 4)
for (const asset of uniqueAssets) {
  const target = asset.startsWith('/') ? asset : '/' + asset.replace(/^\.\//, '')
  const res = await request(target, { headers: { cookie: session } })
  check(`asset ${asset.slice(0, 60)}`, res.status === 200 && res.body.length > 0, `${res.status}, ${res.body.length} bytes`)
}

const wsKey = crypto.randomBytes(16).toString('base64')
const mux = await upgrade('/api/remote.mux', {
  cookie: session,
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-version': '13',
  'sec-websocket-key': wsKey,
  origin,
})
check('/api/remote.mux WebSocket upgrade', mux.status === 101, `status ${mux.status}`)

const health = await request('/__health', { headers: { cookie: session } })
check('/__health reports harness online', health.status === 200 && JSON.parse(health.body.toString()).ok === true,
  health.body.toString().replace(/\s+/g, ' ').slice(0, 120))

// A POST with a JSON body must reach the harness (DSH RPC is POST-only).
const rpcBody = JSON.stringify({})
const rpc = await request('/api/session/list', {
  method: 'POST',
  headers: {
    cookie: session,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(rpcBody),
  },
  body: rpcBody,
})
check('proxied POST /api/session/list reaches harness', rpc.status !== 502 && rpc.status !== 503,
  `status ${rpc.status}, ${rpc.body.length} bytes`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
