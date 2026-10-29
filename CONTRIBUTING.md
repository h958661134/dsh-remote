# Contributing

Thanks for helping make DeepSeek Harness reachable from a phone!

## Ground rules

- Keep the gateway **zero-dependency** (Node built-ins only). Pull requests that add runtime npm
  dependencies will be declined unless there is no reasonable alternative.
- The gateway must never persist the harness `dsh-auth-*` cookie and never send it to clients.
- Keep `plugin/remote-gw.js` tiny and non-invasive: it may read host services and write its state file,
  and must never throw into the host.

## Development

```bash
# gateway
cd gateway
node admin.mjs init          # local config + random password
node server.mjs              # http://127.0.0.1:8787
node selftest.mjs <password> http://127.0.0.1:8787

# headless browser probe (renders what a phone would see)
node probe-browser.mjs http://127.0.0.1:8787 --wait 8000
node probe-browser.mjs http://127.0.0.1:8787 --emulate-old   # simulate Chromium 115
```

The selftest requires a running DeepSeek Harness desktop instance (it proxies to the real host).

## What we would love to see

- Linux/macOS installer scripts (the gateway itself is cross-platform).
- Transport examples: Caddy, frp with TLS, Cloudflare Access policies, ngrok static domains.
- More compatibility validation: Android WebViews, iOS Safari, old Edge.
- Tests for the pure helpers (cookie signing, header rewriting) that do not need a live harness.

## Pull requests

1. One logical change per PR.
2. Update `docs/` when behaviour changes; keep `README.md` and `README.en.md` in sync.
3. Run the checks in `.github/workflows/ci.yml` locally if you can.
## Branch protection on `main`

`main` is protected:

- all five CI checks must pass (`page generators`, `gateway (node 18.x|20.x|22.x)`, `windows scripts parse`);
- the branch must be up to date with `main` before merging (strict);
- changes land through a pull request (no approval required — this is a small project);
- force pushes and branch deletion are disabled, and conversations must be resolved.

Repository admins can still push hotfixes directly, which is deliberate: it keeps emergency
documentation fixes fast without weakening the rules for contributors.