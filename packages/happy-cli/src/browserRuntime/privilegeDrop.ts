/**
 * Production start with the installed permissions (D11).
 *
 * The installer keeps /etc/abp/runtime.json root 0600 and /run/abp
 * root:abp-session 0750, so the Runtime container starts as root holding only
 * CAP_SETUID and CAP_SETGID:
 *
 *   docker run --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID
 *              --security-opt no-new-privileges ...
 *
 * As root it only reads the config (root owns it, so no DAC override is
 * needed) and binds the broker and admin sockets in /run/abp (root owns the
 * directory). The broker socket gets its group by membership, not CAP_CHOWN.
 * It then drops to the image's runtime uid/gid before it opens the state
 * volume or any browser; the kernel clears every capability on that setuid,
 * and the Runtime refuses to continue if any is left.
 */
import { readFile } from 'node:fs/promises'

export interface RuntimeIdentity { uid: number; gid: number }

function positiveId(value: string | undefined): number | undefined {
    return value && /^[1-9]\d*$/.test(value) ? Number(value) : undefined
}

/** The unprivileged identity the image declares (ABP_RUNTIME_UID/GID); never root. */
export function runtimeIdentity(env: NodeJS.ProcessEnv): RuntimeIdentity {
    const uid = positiveId(env.ABP_RUNTIME_UID)
    const gid = positiveId(env.ABP_RUNTIME_GID)
    if (uid === undefined || gid === undefined) throw new Error('ABP_RUNTIME_UID and ABP_RUNTIME_GID must name a non-root runtime user')
    return { uid, gid }
}

/** True when /proc/<pid>/status shows no permitted, effective or ambient capability. */
export function capabilitiesCleared(procStatus: string): boolean {
    const sets = ['CapPrm', 'CapEff', 'CapAmb'].map((name) => new RegExp(`^${name}:\\s*([0-9a-f]+)$`, 'm').exec(procStatus)?.[1])
    return sets.every((value) => value !== undefined && /^0+$/.test(value))
}

/** Identity syscalls, injectable so tests can make each step fail. */
export interface PrivilegeOps {
    getuid(): number
    geteuid(): number
    getgid(): number
    getegid(): number
    setgroups(groups: number[]): void
    setgid(id: number): void
    setuid(id: number): void
    readStatus(): Promise<string>
}

export const processPrivilegeOps: PrivilegeOps = {
    getuid: () => process.getuid?.() ?? -1,
    geteuid: () => process.geteuid?.() ?? -1,
    getgid: () => process.getgid?.() ?? -1,
    getegid: () => process.getegid?.() ?? -1,
    setgroups: (groups) => process.setgroups!(groups),
    setgid: (id) => process.setgid!(id),
    setuid: (id) => process.setuid!(id),
    readStatus: () => readFile('/proc/self/status', 'utf8'),
}

/** Join `gid` so a root-owned socket can be given that group without CAP_CHOWN. */
export function joinGroup(gid: number, ops: PrivilegeOps = processPrivilegeOps): void {
    ops.setgroups([gid])
}

export async function dropRoot(target: RuntimeIdentity, ops: PrivilegeOps = processPrivilegeOps): Promise<void> {
    ops.setgroups([])
    ops.setgid(target.gid)
    ops.setuid(target.uid)
    if (ops.getuid() !== target.uid || ops.geteuid() !== target.uid || ops.getgid() !== target.gid || ops.getegid() !== target.gid)
        throw new Error('ABP runtime could not drop root')
    if (!capabilitiesCleared(await ops.readStatus())) throw new Error('ABP runtime still holds capabilities after dropping root')
}
