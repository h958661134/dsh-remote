## What and why

<!-- One or two sentences: what changes, and the problem it solves. -->

## Checklist

- [ ] The gateway stays **zero-dependency** (Node built-ins only)
- [ ] The harness `dsh-auth-*` cookie is still never persisted or sent to clients
- [ ] `plugin/remote-gw.js` still cannot throw into the host
- [ ] Docs updated when behaviour changed (`README.md` + `README.en.md` kept in sync)
- [ ] `node gateway/selftest.mjs <password> <url>` still passes 12/12 (if the change touches proxying)

## How it was tested

<!-- Commands, environments (OS / Node version), transport used. -->
