import { describe, expect, it } from 'vitest'
import { encodeBase64 } from '@/api/encryption'
import type { Credentials } from '@/persistence'
import { buildMachineIdentity, parseMachineIdentity, reusableDataKeyMachineKey, reusableMachineId } from './machineIdentity'

const bytes = (fill: number) => new Uint8Array(32).fill(fill)
const accountKey = bytes(1)
const otherAccountKey = bytes(2)
const machineKey = bytes(3)
const secret = bytes(4)

const dataKey = (publicKey = accountKey, key = machineKey): Credentials =>
  ({ token: 't', encryption: { type: 'dataKey', publicKey, machineKey: key } })
const legacy = (s = secret): Credentials => ({ token: 't', encryption: { type: 'legacy', secret: s } })

describe('machine identity reuse', () => {
  it('reuses the machine id and key when the same dataKey account logs in again', () => {
    const identity = buildMachineIdentity('machine-1', dataKey())
    expect(reusableDataKeyMachineKey(identity, accountKey)).toEqual(machineKey)
    expect(reusableMachineId(identity, dataKey())).toBe('machine-1')
  })

  it('gives a different account a new machine', () => {
    const identity = buildMachineIdentity('machine-1', dataKey())
    expect(reusableDataKeyMachineKey(identity, otherAccountKey)).toBeNull()
    expect(reusableMachineId(identity, dataKey(otherAccountKey))).toBeNull()
  })

  it('never pairs the old machine id with a different machine key', () => {
    const identity = buildMachineIdentity('machine-1', dataKey())
    expect(reusableMachineId(identity, dataKey(accountKey, bytes(9)))).toBeNull()
  })

  it('reuses the id for the same legacy account and never stores the secret itself', () => {
    const identity = buildMachineIdentity('machine-1', legacy())
    expect(JSON.stringify(identity)).not.toContain(encodeBase64(secret))
    expect(reusableMachineId(identity, legacy())).toBe('machine-1')
    expect(reusableMachineId(identity, legacy(bytes(5)))).toBeNull()
  })

  it('keeps a provisioned legacy machine key for the next provisioning', () => {
    const provisioned: Credentials = { token: 't', encryption: { type: 'legacy', secret, provisioned: { publicKey: accountKey, machineKey } } }
    const identity = buildMachineIdentity('machine-1', provisioned)
    expect(reusableMachineId(identity, legacy())).toBe('machine-1')
    expect(reusableDataKeyMachineKey(identity, accountKey)).toEqual(machineKey)
  })

  it('does not reuse a legacy-only identity for a dataKey login', () => {
    const identity = buildMachineIdentity('machine-1', legacy())
    expect(reusableDataKeyMachineKey(identity, accountKey)).toBeNull()
    expect(reusableMachineId(identity, dataKey())).toBeNull()
  })

  it('treats a missing or malformed identity as absent', () => {
    expect(parseMachineIdentity(null)).toBeNull()
    expect(parseMachineIdentity({ machineId: 42 })).toBeNull()
    expect(reusableMachineId(null, dataKey())).toBeNull()
    const identity = buildMachineIdentity('machine-1', dataKey())
    expect(parseMachineIdentity(JSON.parse(JSON.stringify(identity)))).toEqual(identity)
  })
})
