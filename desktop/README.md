# dsh-remote desktop client

A thin Electron window around the local control panel
(`http://127.0.0.1:8787/__ui/`). It starts the gateway for you if it is not
running, waits for `/__health`, then opens the panel.

## Run from a checkout

```bash
cd desktop
npm install        # downloads Electron (~100 MB) once
npm start
```

## Why this is optional

The control panel is a normal web page served by the gateway. You do **not**
need Electron to use dsh-remote:

- Windows one-click: `scripts/open-app.ps1` (opens the panel in Edge/Chrome app mode)
- any browser: <http://127.0.0.1:8787/__ui/>

The Electron shell only adds a native window, a menu and automatic gateway
startup.

## Packaging (optional)

`npm start` runs the app from the checkout, which is what the project supports
today. To produce an installer you would add `electron-builder` yourself and
include the `gateway/` directory (plus `scripts/`) as extra resources — the
shell resolves the gateway relative to the app root, so pack it as:

```
resources/app/gateway/server.mjs
resources/app/desktop/main.js
```

Please open a PR if you build and test a packaged installer; the repository
deliberately does not commit binary artifacts.

## Notes

- The window loads only `http://127.0.0.1:...`; external links open in your
  default browser.
- If the gateway is already running (for example started by autostart), the
  shell reuses it instead of starting a second instance.
- Quitting the app stops only a gateway process that **it** started.
