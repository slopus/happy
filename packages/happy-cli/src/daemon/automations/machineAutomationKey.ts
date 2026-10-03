import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import tweetnacl from 'tweetnacl'

export interface MachineAutomationKey {
  version: 1
  publicKey: Uint8Array
  secretKey: Uint8Array
  registeredKeyVersion: number
}

function decodeKey(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('automation-key-invalid')
  }
  const decoded = new Uint8Array(Buffer.from(value, 'base64'))
  if (decoded.length !== tweetnacl.box.secretKeyLength) throw new Error('automation-key-invalid')
  return decoded
}

function parse(raw: string): MachineAutomationKey {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (value.version !== 1 || !Number.isSafeInteger(value.registeredKeyVersion)
      || (value.registeredKeyVersion as number) < 0) {
      throw new Error('automation-key-invalid')
    }
    const publicKey = decodeKey(value.publicKey)
    const secretKey = decodeKey(value.secretKey)
    const derived = tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey
    if (!tweetnacl.verify(publicKey, derived)) throw new Error('automation-key-invalid')
    return { version: 1, publicKey, secretKey, registeredKeyVersion: value.registeredKeyVersion as number }
  } catch (error) {
    if (error instanceof Error && error.message === 'automation-key-invalid') throw error
    throw new Error('automation-key-invalid')
  }
}

function persist(filePath: string, key: MachineAutomationKey): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify({
    version: key.version,
    publicKey: Buffer.from(key.publicKey).toString('base64'),
    secretKey: Buffer.from(key.secretKey).toString('base64'),
    registeredKeyVersion: key.registeredKeyVersion,
  }), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
  chmodSync(filePath, 0o600)
}

export function loadOrCreateMachineAutomationKey(filePath: string): MachineAutomationKey {
  try {
    const key = parse(readFileSync(filePath, 'utf8'))
    chmodSync(filePath, 0o600)
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const generated = tweetnacl.box.keyPair()
  const key: MachineAutomationKey = {
    version: 1,
    publicKey: generated.publicKey,
    secretKey: generated.secretKey,
    registeredKeyVersion: 0,
  }
  persist(filePath, key)
  return key
}

/**
 * The daemon's key as it is on disk, or null when there is none or it cannot
 * be read. For processes that use the key but must never create one.
 */
export function readMachineAutomationKey(filePath: string): MachineAutomationKey | null {
  try {
    return parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R17 — replaces the
 * keypair for `happy datakey harden`. A key compat left on disk may have been
 * read by whoever held the machine key, and its holder can open what clients
 * seal for this machine and make envelopes that open as sent by the customer.
 * The new key keeps the version the server has for the old one, so the next
 * registration is accepted as its successor. 'absent' when the daemon has not
 * made a key yet; a corrupt key throws, as it does for the daemon.
 */
export function rotateMachineAutomationKey(filePath: string): 'rotated' | 'absent' {
  let current: MachineAutomationKey
  try {
    current = parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
  const generated = tweetnacl.box.keyPair()
  persist(filePath, {
    version: 1,
    publicKey: generated.publicKey,
    secretKey: generated.secretKey,
    registeredKeyVersion: current.registeredKeyVersion,
  })
  return 'rotated'
}

export function updateMachineAutomationKeyRegistration(
  filePath: string,
  key: MachineAutomationKey,
  registeredKeyVersion: number,
): MachineAutomationKey {
  if (!Number.isSafeInteger(registeredKeyVersion) || registeredKeyVersion < 1) {
    throw new Error('automation-key-version-invalid')
  }
  const updated = { ...key, registeredKeyVersion }
  persist(filePath, updated)
  return updated
}
