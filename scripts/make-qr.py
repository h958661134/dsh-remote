#!/usr/bin/env python
"""Render a QR code PNG for the current phone URL.

    python make-qr.py [output.png]

URL resolution: gateway/tunnel-url.txt -> gateway/config.json publicUrl ->
http://127.0.0.1:8787/

Needs: pip install qrcode pillow
"""
import json
import os
import sys

import qrcode
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATEWAY = os.path.join(ROOT, 'gateway')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'phone-qr.png')


def current_url() -> str:
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
        return f"http://127.0.0.1:{config.get('listenPort', 8787)}/"
    except (OSError, ValueError):
        return 'http://127.0.0.1:8787/'


def font(size):
    for path in (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\segoeui.ttf', '/System/Library/Fonts/PingFang.ttc'):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    return ImageFont.load_default()


url = current_url()
qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=4)
qr.add_data(url)
qr.make(fit=True)
image = qr.make_image(fill_color='#0f1115', back_color='white').convert('RGB')

title_font, hint_font, host_font = font(32), font(22), font(20)
title = 'DeepSeek Harness 手机版'
hint = '在任意网络下扫码打开'
host = url.replace('https://', '').replace('http://', '').strip('/')

probe = ImageDraw.Draw(Image.new('RGB', (10, 10)))
widest = max(
    probe.textlength(title, font=title_font),
    probe.textlength(hint, font=hint_font),
    probe.textlength(host, font=host_font),
)
width = int(max(image.width + 40, widest + 60))
pad_top, pad_bottom = 34, 92
canvas = Image.new('RGB', (width, image.height + pad_top + pad_bottom), 'white')
canvas.paste(image, ((width - image.width) // 2, pad_top))
draw = ImageDraw.Draw(canvas)


def center(text, y, text_font, fill):
    draw.text(((width - draw.textlength(text, font=text_font)) / 2, y), text, font=text_font, fill=fill)


center(title, 24, title_font, '#0f1115')
center(hint, canvas.height - 66, hint_font, '#444444')
center(host, canvas.height - 38, host_font, '#888888')
canvas.save(OUT)
print('saved', OUT, canvas.size, '->', url)
