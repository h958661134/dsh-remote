/* dsh-remote control panel — no framework, no build step. */

const $ = (id) => document.getElementById(id)

const state = {
  status: null,
  passwordVisible: false,
  busy: null,
  logTimer: null,
}

// ── tiny helpers ────────────────────────────────────────────────────────

async function api (path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  })
  const type = response.headers.get('content-type') || ''
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    if (type.includes('json')) {
      try {
        const payload = await response.json()
        if (payload && payload.error) message = payload.error
      } catch {}
    }
    throw new Error(message)
  }
  return type.includes('json') ? response.json() : response.text()
}

let toastTimer = null
function toast (message) {
  const element = $('toast')
  element.textContent = message
  element.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => element.classList.remove('show'), 1800)
}

async function copyText (text) {
  if (!text || text === '—') { toast('没有可复制的内容'); return }
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制')
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try { document.execCommand('copy'); toast('已复制') } catch { toast('复制失败') }
    area.remove()
  }
}

function setBusy (button, busy) {
  if (!button) return
  button.disabled = busy
  button.dataset.busy = busy ? '1' : ''
}

// ── derived values ──────────────────────────────────────────────────────

function publicUrl (status) {
  if (status.tunnel && status.tunnel.url) {
    return status.tunnel.url.endsWith('/') ? status.tunnel.url : status.tunnel.url + '/'
  }
  if (status.tailscale && status.tailscale.serving && status.tailscale.dnsName) {
    return `http://${status.tailscale.dnsName}/`
  }
  return ''
}

function transportLabel (status) {
  if (status.tunnel && status.tunnel.url) return '公网 · Cloudflare'
  if (status.tailscale && status.tailscale.serving) return '私有 · Tailscale'
  return '未发布'
}

// ── QR code ─────────────────────────────────────────────────────────────

function drawQr (url) {
  const canvas = $('qr')
  const context = canvas.getContext('2d')
  const hint = $('qr-hint')
  context.clearRect(0, 0, canvas.width, canvas.height)

  if (!url) {
    hint.textContent = '选择下方通道后生成二维码'
    hint.style.display = ''
    canvas.style.display = 'none'
    return
  }
  hint.style.display = 'none'
  canvas.style.display = ''

  try {
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const count = qr.getModuleCount()
    const margin = 2
    const size = canvas.width
    const cell = size / (count + margin * 2)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, size, size)
    context.fillStyle = '#0f1115'
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (!qr.isDark(row, column)) continue
        context.fillRect(
          Math.floor((column + margin) * cell),
          Math.floor((row + margin) * cell),
          Math.ceil(cell),
          Math.ceil(cell),
        )
      }
    }
  } catch (error) {
    hint.textContent = '二维码生成失败：' + error.message
    hint.style.display = ''
    canvas.style.display = 'none'
  }
}

// ── render ──────────────────────────────────────────────────────────────

function render (status) {
  state.status = status

  const harnessPill = $('harness-pill')
  const harnessText = $('harness-text')
  if (status.harness.ok) {
    harnessPill.className = 'pill ok'
    harnessText.textContent = 'Harness 在线'
  } else {
    harnessPill.className = 'pill bad'
    harnessText.textContent = 'Harness 未运行'
  }
  $('version').textContent = `v${status.version} · ${status.platform}`

  const url = publicUrl(status)
  $('transport-tag').textContent = transportLabel(status)
  $('transport-tag').className = 'tag' + (url ? ' on' : '')
  $('url').textContent = url || '尚未发布通道'
  $('url').dataset.value = url

  const passwordValue = (status.password && status.password.value) || ''
  const passwordBox = $('password')
  passwordBox.textContent = status.password.set
    ? (state.passwordVisible ? (passwordValue || '（口令在 gateway/access.txt）') : '••••••••')
    : '未设置口令'
  passwordBox.dataset.value = passwordValue
  passwordBox.classList.toggle('masked', !state.passwordVisible)
  $('password-eye').textContent = state.passwordVisible ? '隐藏' : '显示'

  drawQr(url)

  // transports
  const ts = status.tailscale || {}
  const tsDot = $('ts-dot')
  const tsButton = $('ts-btn')
  tsDot.className = 'dot' + (ts.serving ? ' on' : (!ts.installed ? '' : (!ts.connected ? ' warn' : '')))
  if (!ts.installed) {
    $('ts-desc').textContent = '未安装。https://tailscale.com/download'
    tsButton.textContent = '不可用'
    tsButton.disabled = true
  } else if (!ts.connected) {
    $('ts-desc').textContent = '已安装但未登录，请先登录同一账号'
    tsButton.textContent = '未登录'
    tsButton.disabled = true
  } else {
    $('ts-desc').textContent = ts.serving ? `已发布到 ${ts.dnsName}` : '只有你账号下的设备能连，不暴露公网'
    tsButton.textContent = ts.serving ? '撤销发布' : '发布'
    tsButton.disabled = false
    tsButton.classList.toggle('danger', Boolean(ts.serving))
  }

  const tunnel = status.tunnel || {}
  const cfDot = $('cf-dot')
  const cfButton = $('cf-btn')
  cfDot.className = 'dot' + (tunnel.running ? ' on' : (tunnel.starting ? ' warn' : ''))
  if (tunnel.running && tunnel.url) {
    $('cf-desc').textContent = tunnel.url.replace('https://', '')
    cfButton.textContent = '停止'
    cfButton.classList.add('danger')
    cfButton.disabled = false
  } else if (tunnel.starting) {
    $('cf-desc').textContent = '正在分配地址…'
    cfButton.textContent = '启动中…'
    cfButton.disabled = true
    cfButton.classList.remove('danger')
  } else {
    $('cf-desc').textContent = 'HTTPS 公网地址，无需账号；地址重启会变'
    cfButton.textContent = '启动'
    cfButton.classList.remove('danger')
    cfButton.disabled = false
  }

  // runtime
  $('kv-listen').textContent = status.listen
  $('kv-harness').textContent = status.harness.ok ? `127.0.0.1:${status.harness.port}` : '未检测到'

  const autostart = $('autostart')
  autostart.checked = Boolean(status.autostart && status.autostart.enabled)
  autostart.disabled = !(status.autostart && status.autostart.supported)
  $('autostart-note').textContent = status.autostart && status.autostart.supported ? '' : '（仅 Windows 支持）'
}

async function refresh () {
  try {
    const status = await api('/__api/status')
    render(status)
  } catch (error) {
    $('harness-pill').className = 'pill bad'
    $('harness-text').textContent = '网关无响应'
    $('version').textContent = ''
    console.error(error)
  }
}

async function refreshLogs () {
  try {
    const text = await api('/__api/logs?lines=200')
    const pre = $('logs')
    const nearBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40
    pre.textContent = text
    if (nearBottom) pre.scrollTop = pre.scrollHeight
  } catch {
    /* ignore */
  }
}

// ── actions ─────────────────────────────────────────────────────────────

function bindActions () {
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = $(button.dataset.copy)
      copyText(target.dataset.value || target.textContent)
    })
  })

  $('refresh-link').addEventListener('click', async () => {
    await refresh()
    toast('已刷新')
  })

  $('open-link').addEventListener('click', () => {
    const url = $('url').dataset.value
    if (!url) { toast('还没有可访问的地址'); return }
    window.open(url, '_blank', 'noopener')
  })

  $('password-eye').addEventListener('click', () => {
    state.passwordVisible = !state.passwordVisible
    if (state.status) render(state.status)
  })

  $('logs-refresh').addEventListener('click', refreshLogs)

  $('ts-btn').addEventListener('click', async () => {
    const status = state.status
    if (!status) return
    const action = status.tailscale.serving ? 'reset' : 'serve'
    const button = $('ts-btn')
    setBusy(button, true)
    try {
      const result = await api('/__api/tailscale', { method: 'POST', body: JSON.stringify({ action }) })
      toast(action === 'serve' ? `已发布：${result.url || '完成'}` : '已撤销发布')
      await refresh()
    } catch (error) {
      toast(error.message)
    } finally {
      setBusy(button, false)
      await refresh()
    }
  })

  $('cf-btn').addEventListener('click', async () => {
    const status = state.status
    if (!status) return
    const action = status.tunnel.running ? 'stop' : 'start'
    const button = $('cf-btn')
    setBusy(button, true)
    try {
      const result = await api('/__api/tunnel', { method: 'POST', body: JSON.stringify({ action }) })
      toast(action === 'start' ? `隧道已启动：${result.url || ''}` : '隧道已停止')
      await refresh()
    } catch (error) {
      toast(error.message)
    } finally {
      setBusy(button, false)
      await refresh()
    }
  })

  $('autostart').addEventListener('change', async (event) => {
    const enabled = event.target.checked
    try {
      const result = await api('/__api/autostart', { method: 'POST', body: JSON.stringify({ enabled }) })
      if (result.autostart) render({ ...state.status, autostart: result.autostart })
      toast(enabled ? '已开启开机自启' : '已关闭开机自启')
    } catch (error) {
      toast(error.message)
      event.target.checked = !enabled
    }
  })

  // password dialog
  const dialog = $('password-dialog')
  $('password-change').addEventListener('click', () => {
    $('new-password').value = ''
    $('new-password2').value = ''
    $('password-error').textContent = ''
    dialog.showModal()
    $('new-password').focus()
  })
  $('password-cancel').addEventListener('click', () => dialog.close())
  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const first = $('new-password').value
    const second = $('new-password2').value
    const error = $('password-error')
    if (first.length < 8) { error.textContent = '口令至少 8 位'; return }
    if (first !== second) { error.textContent = '两次输入不一致'; return }
    try {
      await api('/__api/password', { method: 'POST', body: JSON.stringify({ password: first }) })
      dialog.close()
      toast('口令已更新')
      state.passwordVisible = true
      await refresh()
    } catch (reason) {
      error.textContent = reason.message
    }
  })
}

// ── boot ────────────────────────────────────────────────────────────────

bindActions()
refresh()
refreshLogs()
setInterval(() => { if (!document.hidden) refresh() }, 3000)
setInterval(() => { if (!document.hidden) refreshLogs() }, 6000)
