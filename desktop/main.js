/**
 * dsh-remote desktop client.
 *
 * A thin window around the local control panel (`http://127.0.0.1:8787/__ui/`).
 * If the gateway is not running, this starts `gateway/server.mjs` first and
 * waits for `/__health`, then opens the window.
 *
 *   cd desktop && npm install && npm start
 *
 * The gateway itself is plain Node.js — the desktop shell is optional. The
 * same UI is reachable in any browser at http://127.0.0.1:8787/__ui/
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const PORT = Number(process.env.DSH_REMOTE_PORT || 8787)
const ORIGIN = `http://127.0.0.1:${PORT}`
const PANEL_URL = `${ORIGIN}/__ui/`
const ROOT = path.resolve(__dirname, '..')
const GATEWAY_DIR = path.join(ROOT, 'gateway')
const GATEWAY_ENTRY = path.join(GATEWAY_DIR, 'server.mjs')

let gatewayProcess = null
let mainWindow = null

function probeGateway (timeout = 800) {
  return new Promise((resolve) => {
    const request = http.get(`${ORIGIN}/__health`, { timeout }, (response) => {
      response.resume()
      resolve(response.statusCode === 200)
    })
    request.on('timeout', () => { request.destroy(); resolve(false) })
    request.on('error', () => resolve(false))
  })
}

function gatewayLogHandle () {
  try {
    fs.mkdirSync(GATEWAY_DIR, { recursive: true })
    return fs.openSync(path.join(GATEWAY_DIR, 'gateway.log'), 'a')
  } catch {
    return 'ignore'
  }
}

async function ensureGateway () {
  if (await probeGateway()) return { ok: true, started: false }
  if (!fs.existsSync(GATEWAY_ENTRY)) {
    return { ok: false, error: `没有找到网关：${GATEWAY_ENTRY}\n请把桌面客户端放在仓库根目录下（与 gateway/ 同级）。` }
  }

  const log = gatewayLogHandle()
  try {
    gatewayProcess = spawn(process.env.DSH_REMOTE_NODE || 'node', [GATEWAY_ENTRY], {
      cwd: GATEWAY_DIR,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', log, log],
    })
  } catch (error) {
    return { ok: false, error: `启动网关失败：${error.message}` }
  }
  gatewayProcess.on('error', () => {})
  gatewayProcess.on('exit', () => { gatewayProcess = null })

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await probeGateway()) return { ok: true, started: true }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { ok: false, error: '网关启动超时。请运行 scripts/doctor.ps1 检查。' }
}

function buildMenu () {
  const template = [
    {
      label: 'dsh-remote',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '在浏览器打开控制台', click: () => shell.openExternal(PANEL_URL) },
        { label: '打开日志目录', click: () => shell.openPath(GATEWAY_DIR) },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 940,
    minHeight: 720,
    title: 'dsh-remote',
    backgroundColor: '#0a0c12',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  mainWindow.loadURL(PANEL_URL).catch(() => {})
  mainWindow.on('closed', () => { mainWindow = null })
  // external links (the phone URL preview) go to the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) return { action: 'allow' }
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
}

async function boot () {
  const result = await ensureGateway()
  if (!result.ok) {
    dialog.showErrorBox('dsh-remote 启动失败', result.error || '未知错误')
    app.quit()
    return
  }
  buildMenu()
  createWindow()
}

app.whenReady().then(boot)
app.on('activate', () => { if (mainWindow === null) boot() })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  if (gatewayProcess) {
    try { gatewayProcess.kill() } catch {}
    gatewayProcess = null
  }
})
