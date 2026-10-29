# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub **Security Advisories** on this repository.
Do not open a public issue with exploit details before a fix is available.

## What this project touches

`dsh-remote` runs a small HTTP gateway next to the DeepSeek Harness desktop app and forwards
authenticated traffic to `127.0.0.1`. It reads:

- `remote-gw-state.json` — the Harness launch token (a local credential, written by the plugin, `0600`);
- `gateway/config.json` — password hash (scrypt), session signing secret, listen addresses.

It never stores the Harness `dsh-auth-*` cookie on disk and never sends it to clients.

## Threat model

Protected against: unauthenticated access from the internet or LAN (password + signed session cookie),
session fixation (per-login signed cookie), credential leakage to the phone (Harness cookie stays in the
gateway process), CSRF-style cross-site requests (SameSite cookies + Origin checks by the harness).

**Not** protected against: an attacker who already controls the local machine or the user account
(they can read the state file and config), or a compromised tunnel provider.

## Hardening checklist for public exposure

- Use a long random password (`admin.mjs init` generates 14 chars; 12+ is a reasonable floor).
- Put an identity layer in front when possible: Cloudflare Access, Tailscale ACLs, or an IP allowlist.
- Keep `listenHost` at `127.0.0.1`; let Tailscale/tunnel terminate the connection.
- Rotate `sessionSecret` in `gateway/config.json` (and restart the gateway) to revoke every issued phone session.
- Watch `gateway.log` for `login failed from <ip>` spikes.
- Set `publicUrl` to the HTTPS URL so session cookies get the `Secure` flag.

## Supported versions

The latest commit on `main`. Security fixes are applied there only.
