import { describe, expect, it } from 'vitest'
import { capabilitiesCleared, dropRoot, runtimeIdentity, type PrivilegeOps } from './privilegeDrop'

const status = (caps: { prm?: string; eff?: string; amb?: string } = {}) => [
    'Name:\tnode', 'Uid:\t10870\t10870\t10870\t10870', 'Gid:\t10870\t10870\t10870\t10870',
    `CapInh:\t0000000000000000`, `CapPrm:\t${caps.prm ?? '0000000000000000'}`, `CapEff:\t${caps.eff ?? '0000000000000000'}`,
    'CapBnd:\t00000000000000c0', `CapAmb:\t${caps.amb ?? '0000000000000000'}`, '',
].join('\n')

describe('privilege drop', () => {
    it('reads the unprivileged runtime identity from the image environment', () => {
        expect(runtimeIdentity({ ABP_RUNTIME_UID: '10870', ABP_RUNTIME_GID: '10870' })).toEqual({ uid: 10870, gid: 10870 })
    })

    it.each([
        [{}],
        [{ ABP_RUNTIME_UID: '0', ABP_RUNTIME_GID: '10870' }],
        [{ ABP_RUNTIME_UID: '10870', ABP_RUNTIME_GID: '0' }],
        [{ ABP_RUNTIME_UID: '10870x', ABP_RUNTIME_GID: '10870' }],
    ])('refuses a missing or root runtime identity %j', (env) => {
        expect(() => runtimeIdentity(env)).toThrow(/ABP_RUNTIME_UID/)
    })

    it('accepts a process only when its permitted, effective and ambient capabilities are empty', () => {
        expect(capabilitiesCleared(status())).toBe(true)
        expect(capabilitiesCleared(status({ prm: '00000000000000c0' }))).toBe(false)
        expect(capabilitiesCleared(status({ eff: '0000000000000080' }))).toBe(false)
        expect(capabilitiesCleared(status({ amb: '0000000000000040' }))).toBe(false)
        expect(capabilitiesCleared('Name:\tnode\n')).toBe(false)
    })
})

describe('dropRoot', () => {
    const cleared = status()
    function fakeOps(overrides: Partial<PrivilegeOps> = {}) {
        const calls: string[] = []
        const ids = { uid: 0, gid: 0 }
        const ops: PrivilegeOps = {
            getuid: () => ids.uid, geteuid: () => ids.uid, getgid: () => ids.gid, getegid: () => ids.gid,
            setgroups: (groups) => { calls.push(`setgroups:${groups.join(',')}`) },
            setgid: (id) => { calls.push(`setgid:${id}`); ids.gid = id },
            setuid: (id) => { calls.push(`setuid:${id}`); ids.uid = id },
            readStatus: async () => cleared,
            ...overrides,
        }
        return { ops, calls }
    }
    const target = { uid: 10870, gid: 10870 }

    it('clears supplementary groups, then sets the gid, then the uid', async () => {
        const { ops, calls } = fakeOps()
        await dropRoot(target, ops)
        expect(calls).toEqual(['setgroups:', 'setgid:10870', 'setuid:10870'])
    })

    it('propagates a failed setuid', async () => {
        const { ops } = fakeOps({ setuid: () => { throw Object.assign(new Error('EPERM, Operation not permitted'), { code: 'EPERM' }) } })
        await expect(dropRoot(target, ops)).rejects.toThrow(/EPERM/)
    })

    it('refuses when the ids did not actually change', async () => {
        const { ops } = fakeOps({ setuid: () => undefined })
        await expect(dropRoot(target, ops)).rejects.toThrow(/could not drop root/)
    })

    it('refuses when a capability survived the drop', async () => {
        const { ops } = fakeOps({ readStatus: async () => status({ eff: '0000000000000080' }) })
        await expect(dropRoot(target, ops)).rejects.toThrow(/still holds capabilities/)
    })
})
