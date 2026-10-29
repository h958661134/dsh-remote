#!/usr/bin/env node
/**
 * Headless Chromium probe: load a URL, collect console errors / exceptions,
 * and report what the page actually rendered. Useful to reproduce what a
 * phone browser sees without touching the phone.
 *
 *   node probe-browser.mjs <url> [--wait 8000] [--width 390] [--height 844] [--screenshot out.png]
 *
 * Requires Microsoft Edge (default) or Chrome installed. Uses the DevTools
 * protocol over a local debugging port; no extra npm packages.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

const args = process.argv.slice(2)
const url = args.find((a) => a.startsWith('http'))
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const waitMs = Number(flag('--wait', '9000'))
const width = Number(flag('--width', '390'))
const height = Number(flag('--height', '844'))
const screenshot = flag('--screenshot', '')
const port = Number(flag('--port', '9333'))

if (!url) {
  console.error('usage: node probe-browser.mjs <url> [--wait ms] [--width px] [--height px] [--screenshot file]')
  process.exit(2)
}

const executable = EDGE_CANDIDATES.find((p) => fs.existsSync(p))
if (!executable) {
  console.error('no Chromium binary found')
  process.exit(2)
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-'))
const child = spawn(executable, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targets () {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(200)
  }
  throw new Error('devtools endpoint not reachable')
}

const page = await targets()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let nextId = 1
const pending = new Map()
const errors = []
const consoleLines = []
const requests = { failed: [] }

ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id).resolve(message.result)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const d = message.params.exceptionDetails
    errors.push(d.exception?.description || d.text)
  } else if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
    consoleLines.push(`${message.params.type}: ${text}`)
    if (message.params.type === 'error') errors.push(text)
  } else if (message.method === 'Log.entryAdded') {
    const e = message.params.entry
    if (e.level === 'error') errors.push(`${e.source}: ${e.text}`)
  } else if (message.method === 'Network.loadingFailed') {
    requests.failed.push(`${message.params.requestId} ${message.params.errorText}`)
  }
}

function send (method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.enable')

// Emulate an older Chromium (e.g. Android WebView / OPPO HeyTapBrowser on 115)
// by removing APIs the harness expects from newer engines. The gateway's
// compatibility layer is supposed to put them back.
if (args.includes('--emulate-old')) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const drop = (obj, names) => { for (const n of names) { try { delete obj[n] } catch (e) {} } };
      drop(Promise, ['withResolvers']);
      drop(Array, ['fromAsync']);
      drop(Object, ['groupBy']);
      drop(Map, ['groupBy']);
      drop(URL, ['canParse', 'parse']);
      drop(AbortSignal, ['any']);
      drop(Set.prototype, ['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom']);
      try { delete Crypto.prototype.randomUUID } catch (e) {}
      try { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) } catch (e) {}
      window.__EMULATED_OLD__ = true;
      window.__EMULATED__ = {
        withResolvers: typeof Promise.withResolvers,
        fromAsync: typeof Array.fromAsync,
        toSorted: typeof Array.prototype.toSorted,
        canParse: typeof URL.canParse,
        uuid: typeof (crypto && crypto.randomUUID),
      };
    })()`,
  })
}
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url })
await sleep(waitMs)

const evaluated = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    secure: window.isSecureContext,
    url: location.href,
    compat: window.__DSHGW_COMPAT__ || null,
    emulated: window.__EMULATED__ || null,
    text: (document.body && document.body.innerText || '').slice(0, 2000),
    rootChildren: (document.getElementById('root') || document.body).children.length,
    htmlLength: document.documentElement.outerHTML.length
  })`,
  returnByValue: true,
})

if (screenshot) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'))
}

const info = JSON.parse(evaluated.result.value)
console.log(JSON.stringify({
  ...info,
  errors,
  consoleTail: consoleLines.slice(-15),
  failedRequests: requests.failed.slice(0, 10),
}, null, 2))

ws.close()
child.kill()
await sleep(300)
try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
