import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  loadOrCreateMachineAutomationKey,
  readMachineAutomationKey,
  rotateMachineAutomationKey,
  updateMachineAutomationKeyRegistration,
} from './machineAutomationKey'

describe('machineAutomationKey', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'machine-automation-key-'))
    file = path.join(dir, 'automation-key.v1.json')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates one persistent X25519 keypair atomically with owner-only permissions', () => {
    const first = loadOrCreateMachineAutomationKey(file)
    const second = loadOrCreateMachineAutomationKey(file)

    expect(first).toEqual(second)
    expect(first.publicKey).toHaveLength(32)
    expect(first.secretKey).toHaveLength(32)
    expect(first.registeredKeyVersion).toBe(0)
    expect(readdirSync(dir)).toEqual(['automation-key.v1.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('atomically persists the acknowledged server key version without rotating the keypair', () => {
    const key = loadOrCreateMachineAutomationKey(file)
    const registered = updateMachineAutomationKeyRegistration(file, key, 3)
    const reloaded = loadOrCreateMachineAutomationKey(file)

    expect(registered.registeredKeyVersion).toBe(3)
    expect(reloaded).toEqual(registered)
    expect(reloaded.publicKey).toEqual(key.publicKey)
    expect(reloaded.secretKey).toEqual(key.secretKey)
    expect(readdirSync(dir)).toEqual(['automation-key.v1.json'])
  })

  it('repairs permissive file mode but refuses a corrupt key instead of losing decryptability', () => {
    const key = loadOrCreateMachineAutomationKey(file)
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644)
      expect(loadOrCreateMachineAutomationKey(file)).toEqual(key)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }

    writeFileSync(file, JSON.stringify({ version: 1, publicKey: 'bad', secretKey: 'bad', registeredKeyVersion: 0 }))
    expect(() => loadOrCreateMachineAutomationKey(file)).toThrow('automation-key-invalid')
    expect(readFileSync(file, 'utf8')).toContain('"publicKey":"bad"')
  })

  // A session process reads the daemon's key to seal scripts its agent registers; it never makes one.
  it('reads the daemon key without creating one where there is none or it is unusable', () => {
    expect(readMachineAutomationKey(file)).toBeNull()
    expect(readdirSync(dir)).toEqual([])

    const created = loadOrCreateMachineAutomationKey(file)
    expect(readMachineAutomationKey(file)).toEqual(created)

    writeFileSync(file, '{ corrupt')
    expect(readMachineAutomationKey(file)).toBeNull()
  })

  // aplus-dev-studio specs/e2ee-machine-control-boundary R17 — hardening replaces a key compat left readable.
  it('rotates to a new keypair under the version the server has, so it registers as that key\'s successor', () => {
    const old = updateMachineAutomationKeyRegistration(file, loadOrCreateMachineAutomationKey(file), 4)

    expect(rotateMachineAutomationKey(file)).toBe('rotated')
    const rotated = loadOrCreateMachineAutomationKey(file)

    expect(rotated.registeredKeyVersion).toBe(4)
    expect(rotated.publicKey).not.toEqual(old.publicKey)
    expect(rotated.secretKey).not.toEqual(old.secretKey)
    expect(readdirSync(dir)).toEqual(['automation-key.v1.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('leaves a missing key for the daemon to make and refuses to overwrite a corrupt one', () => {
    expect(rotateMachineAutomationKey(file)).toBe('absent')
    expect(readdirSync(dir)).toEqual([])

    writeFileSync(file, '{ corrupt')
    expect(() => rotateMachineAutomationKey(file)).toThrow('automation-key-invalid')
    expect(readFileSync(file, 'utf8')).toBe('{ corrupt')
  })
})
