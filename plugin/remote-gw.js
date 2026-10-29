// DeepSeek Harness desktop plugin: export the launch token of this process.
//
// The desktop app binds its Web GUI to 127.0.0.1 with a random port and a random
// per-process launch token. A process outside the harness cannot learn either,
// so this plugin writes them to a small state file that the gateway reads:
//
//   { "port": 62228, "launchUrl": "http://127.0.0.1:62228/?token=...", ... }
//
// Install: add this row to $DSH_HOME/profiles/desktop/cordis.patch.yml
//
//   - insert:
//       - id: remote-gw
//         name: ./remote-gw.js
//
// and copy this file next to that patch file. The profile loader hot-mounts it;
// no restart of the desktop app is required. The plugin re-runs on every app
// start (and every loader refresh), so the state file always tracks the current
// port and token.
const fs = require('node:fs')
const path = require('node:path')

const name = 'remote-gw'
const inject = ['webServer', 'connection']

const STATE_PATH = path.join(__dirname, 'remote-gw-state.json')

function apply(ctx) {
  const write = (payload) => {
    try {
      const tmp = `${STATE_PATH}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, STATE_PATH)
    } catch {
      /* never break the host because the export failed */
    }
  }

  try {
    const port = ctx.webServer.port
    const protocol = ctx.webServer.protocol
    const origin = `${protocol}//127.0.0.1:${port}`
    write({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      pid: process.pid,
      port,
      protocol,
      origin,
      launchUrl: ctx.connection.authenticatedUrl(origin),
    })
    ctx.logger('remote-gw').info(`remote-gw: exported launch state for port ${port}`)
  } catch (error) {
    write({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      pid: process.pid,
      error: String((error && error.stack) || error),
    })
  }
}

module.exports = { name, inject, apply }
