#!/usr/bin/env python
"""Render the desktop helper page: QR code, phone URL and access password.

    python make-page.py [password|-] [output.html] [url]

Resolution order:
  password : argv[1] (or "-"/empty -> gateway/access.txt)
  url      : argv[3] -> gateway/tunnel-url.txt -> gateway/config.json publicUrl
             -> http://127.0.0.1:8787/
  output   : argv[2] -> <repo>/phone-access.html

Needs: pip install qrcode pillow
"""
import base64
import io
import json
import os
import sys

import qrcode

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATEWAY = os.path.join(ROOT, 'gateway')


def read_password() -> str:
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    if arg and arg != '-':
        return arg
    try:
        with open(os.path.join(GATEWAY, 'access.txt'), encoding='utf-8') as handle:
            for line in handle:
                if line.startswith('password:'):
                    return line.split(':', 1)[1].strip()
    except OSError:
        pass
    return ''


def read_url() -> str:
    if len(sys.argv) > 3 and sys.argv[3]:
        return sys.argv[3]
    try:
        with open(os.path.join(GATEWAY, 'tunnel-url.txt'), encoding='utf-8') as handle:
            candidate = handle.read().strip()
        if candidate:
            return candidate if candidate.endswith('/') else candidate + '/'
    except OSError:
        pass
    try:
        with open(os.path.join(GATEWAY, 'config.json'), encoding='utf-8') as handle:
            config = json.load(handle)
        public_url = (config.get('publicUrl') or '').strip()
        if public_url:
            return public_url if public_url.endswith('/') else public_url + '/'
        port = config.get('listenPort', 8787)
        return f'http://127.0.0.1:{port}/'
    except (OSError, ValueError):
        return 'http://127.0.0.1:8787/'


def make_qr(url: str) -> str:
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=3)
    qr.add_data(url)
    qr.make(fit=True)
    image = qr.make_image(fill_color='#0f1115', back_color='white').convert('RGB')
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


PASSWORD = read_password()
URL = read_url()
OUT = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != '-' else os.path.join(ROOT, 'phone-access.html')
QR_URI = make_qr(URL)

HTML = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>手机访问 DeepSeek Harness</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    background:#0f1115; color:#e6e8ee; padding:28px; }}
  .wrap {{ width:100%; max-width:760px; display:grid; grid-template-columns:300px 1fr; gap:28px; align-items:start; }}
  @media (max-width:720px) {{ .wrap {{ grid-template-columns:1fr; }} }}
  .card {{ background:#171a21; border:1px solid #262b36; border-radius:18px; padding:24px; }}
  .qr {{ text-align:center; }}
  .qr img {{ width:100%; max-width:260px; border-radius:12px; background:#fff; padding:10px; }}
  h1 {{ font-size:20px; margin:0 0 4px; }}
  .sub {{ color:#8b93a7; font-size:13px; margin:0 0 18px; }}
  .row {{ display:flex; gap:10px; align-items:center; margin:10px 0; flex-wrap:wrap; }}
  .label {{ color:#8b93a7; font-size:12px; width:100%; }}
  code {{ background:#0f1218; border:1px solid #262b36; border-radius:8px; padding:7px 10px; font-size:14px;
    font-family: ui-monospace,Consolas,monospace; word-break:break-all; }}
  button {{ border:0; border-radius:8px; padding:8px 12px; font-size:13px; background:#2b3242; color:#cfd6e6; cursor:pointer; }}
  button:hover {{ background:#39445a; }}
  ol {{ margin:14px 0 0; padding-left:20px; }}
  ol li {{ margin:7px 0; }}
  .status {{ display:inline-flex; align-items:center; gap:7px; font-size:13px; padding:6px 10px;
    border-radius:999px; background:#1d2430; color:#9aa6bd; }}
  .dot {{ width:8px; height:8px; border-radius:50%; background:#6b7688; }}
  .dot.ok {{ background:#3ddc84; box-shadow:0 0 8px #3ddc8499; }}
  .dot.bad {{ background:#ff6b6b; box-shadow:0 0 8px #ff6b6b99; }}
  .hint {{ color:#7c869c; font-size:12px; margin-top:18px; }}
  .kbd {{ background:#0f1218; border:1px solid #262b36; border-radius:6px; padding:2px 7px; font-size:12px; }}
</style></head><body>
<div class="wrap">
  <div class="card qr">
    <img src="{QR_URI}" alt="扫码打开">
    <div class="status" style="margin-top:14px"><span class="dot" id="dot"></span><span id="sttext">检查中…</span></div>
  </div>
  <div class="card">
    <h1>手机访问 DeepSeek Harness</h1>
    <p class="sub">手机无需与电脑同一局域网：地址由 Tailscale 或隧道提供。</p>

    <div class="label">访问地址</div>
    <div class="row"><code id="url">{URL}</code><button onclick="copy('url')">复制</button></div>

    <div class="label">访问口令</div>
    <div class="row"><code id="pw">{PASSWORD or '（见 gateway/access.txt）'}</code><button onclick="copy('pw')">复制</button></div>

    <ol>
      <li>手机浏览器打开上面的地址，或直接扫左边二维码。</li>
      <li>输入访问口令（一次登录，默认 30 天免密）。</li>
      <li>浏览器菜单里选「添加到主屏幕」，以后一点就进。</li>
    </ol>

    <div class="hint">
      地址来自 Tailscale 或隧道；地址变化时重跑 <span class="kbd">scripts/refresh-tunnel.ps1</span> 即可生成新页。<br>
      安卓同一时间只能开一个 VPN：Tailscale 与 Clash 互斥，用哪个开哪个。
    </div>
  </div>
</div>
<script>
async function copy(id) {{
  const text = document.getElementById(id).textContent;
  try {{ await navigator.clipboard.writeText(text); }} catch (e) {{
    const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area);
    area.select(); document.execCommand('copy'); area.remove();
  }}
}}
async function poll() {{
  const dot = document.getElementById('dot'), text = document.getElementById('sttext');
  try {{
    const response = await fetch('http://127.0.0.1:8787/__health', {{ cache: 'no-store' }});
    const health = await response.json();
    if (health.ok) {{ dot.className = 'dot ok'; text.textContent = '网关在线 · Harness 已连接'; }}
    else {{ dot.className = 'dot bad'; text.textContent = '网关在线 · Harness 未运行'; }}
  }} catch (error) {{
    dot.className = 'dot bad'; text.textContent = '网关未运行';
  }}
}}
poll(); setInterval(poll, 5000);
</script>
</body></html>
"""

with open(OUT, 'w', encoding='utf-8') as handle:
    handle.write(HTML)
print('page written:', OUT, len(HTML), 'chars ->', URL)
