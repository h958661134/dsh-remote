#!/usr/bin/env node
/**
 * DSH Remote Gateway config helper.
 *
 *   node admin.mjs init                    create config.json (random secret + random password)
 *   node admin.mjs set-password <pw>       set / rotate the access password
 *   node admin.mjs set-password            generate a random password and print it
 *   node admin.mjs show                    print the effective config (password hidden)
 *
 * The plaintext password is also written to access.txt (owner-only) so the
 * local control panel can display it. Keep that file private.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.DSHGW_CONFIG || path.join(HERE, 'config.json')
const ACCESS_PATH = path.join(HERE, 'access.txt')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_PATH = path.join(DSH_HOME, 'profiles', 'desktop', 'remote-gw-state.json')

function read () {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('config.json missing — run: node admin.mjs init')
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
}

function write (cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
}

function writeAccess (password) {
  try {
    fs.writeFileSync(ACCESS_PATH, `password: ${password}\ngenerated: ${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch {
    /* access.txt is a convenience for the control panel, not a requirement */
  }
}

function hashPassword (password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

function randomPassword () {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(14)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

const [, , command, ...rest] = process.argv

switch (command) {
  case 'init': {
    if (fs.existsSync(CONFIG_PATH) && !rest.includes('--force')) {
      console.error('config.json already exists (use --force to overwrite)')
      process.exit(1)
    }
    const password = randomPassword()
    const cfg = {
      listenHost: '127.0.0.1',
      listenPort: 8787,
      stateFile: STATE_PATH,
      sessionSecret: crypto.randomBytes(32).toString('base64url'),
      sessionMaxAgeDays: 30,
      auth: { mode: 'password', password: hashPassword(password) },
      clientSupport: true,
      publicUrl: '',
    }
    write(cfg)
    writeAccess(password)
    console.log('config written:', CONFIG_PATH)
    console.log('access password:', password)
    break
  }
  case 'set-password': {
    const cfg = read()
    const password = rest[0] || randomPassword()
    cfg.auth = { mode: 'password', password: hashPassword(password) }
    write(cfg)
    writeAccess(password)
    console.log('password updated')
    console.log('access password:', password)
    break
  }
  case 'show': {
    const cfg = read()
    const shown = { ...cfg, auth: { mode: cfg.auth?.mode, password: cfg.auth?.password ? '<hidden>' : null } }
    shown.sessionSecret = cfg.sessionSecret ? '<hidden>' : null
    console.log(JSON.stringify(shown, null, 2))
    break
  }
  default:
    console.log(`usage:
  node admin.mjs init [--force]
  node admin.mjs set-password [password]
  node admin.mjs show`)
}
