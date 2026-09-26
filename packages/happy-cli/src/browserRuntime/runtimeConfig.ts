/**
 * Runtime configuration file (`/etc/abp/runtime.json`, root 0600, mounted
 * read-only into the Runtime container).
 *
 * Identity (machine, workspace, profile owners) and trust (issuer public
 * keys, daemon token hash) come only from here, never from a request. The
 * file holds no secret: the daemon token is stored as its SHA-256.
 * Errors name the offending field but never quote file content.
 */
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { TrustedIssuer } from './auth'
import type { AuthMode, MachineId, PrincipalId, ProfileId, WorkspaceId } from './contracts'

const id = z.string().min(1).max(256)
const origin = z.string().refine((value) => {
    try { return new URL(value).origin === value } catch { return false }
}, 'must be a bare origin such as https://shop.example')

const profileSchema = z.object({
    profileId: id,
    principalId: id,
    /** Browser container endpoints; may instead come from ABP_PROFILES. */
    cdpHttpUrl: z.string().url().optional(),
    instanceUrl: z.string().url().optional(),
    /** x11vnc of the browser container on the profile network (`host:port`), for the Runtime viewer. */
    vncAddress: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}:\d{1,5}$/, 'must be host:port').optional(),
}).strict()

const schema = z.object({
    schemaVersion: z.literal(1).default(1),
    authMode: z.enum(['harness', 'production']),
    machineId: id,
    workspaceId: id,
    profiles: z.array(profileSchema).min(1),
    trustedIssuers: z.array(z.object({ kid: id, publicKeyPem: z.string().min(1).max(4096) }).strict()).default([]),
    /** Site policy entries; their action rules are validated by the policy module. */
    sites: z.array(z.object({ origin }).passthrough()).default([]),
    runtimeHost: z.string().min(1).default('0.0.0.0'),
    runtimePort: z.number().int().min(1).max(65_535).default(8787),
    brokerSocketPath: z.string().startsWith('/').default('/run/abp/broker.sock'),
    adminSocketPath: z.string().startsWith('/').default('/run/abp/admin.sock'),
    /** Group that may connect to the broker socket (abp-session); the Runtime chowns the socket to it. */
    brokerSocketGid: z.number().int().nonnegative().optional(),
    /** SHA-256 (hex) of the daemon token installed at /var/lib/abp/daemon-token. */
    daemonTokenSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** Origins the viewer WebSocket accepts besides loopback ones. Defense in depth only: the one-time viewer ticket is the boundary. */
    viewerOrigins: z.array(origin).default([]),
    maxAgentWindows: z.number().int().min(1).max(16).default(4),
    /** Open task spaces per profile; default min(4, maxAgentWindows), never above maxAgentWindows. */
    maxSpacesPerProfile: z.number().int().min(1).max(16).optional(),
    /** Spaces whose tasks are all finished are closed after this long without activity. */
    spaceIdleReclaimMs: z.number().int().min(60_000).max(24 * 60 * 60_000).default(15 * 60_000),
    retentionDays: z.number().int().min(1).max(365).default(7),
}).strict().superRefine((config, ctx) => {
    const seen = new Set<string>()
    for (const [index, profile] of config.profiles.entries()) {
        if (seen.has(profile.profileId)) ctx.addIssue({ code: 'custom', path: ['profiles', index, 'profileId'], message: 'duplicate profileId' })
        seen.add(profile.profileId)
    }
    for (const [index, issuer] of config.trustedIssuers.entries()) {
        let type: string | undefined
        try { type = createPublicKey(issuer.publicKeyPem).asymmetricKeyType } catch { type = undefined }
        if (type !== 'ed25519') ctx.addIssue({ code: 'custom', path: ['trustedIssuers', index, 'publicKeyPem'], message: 'must be an Ed25519 public key (PEM)' })
    }
    if (config.maxSpacesPerProfile !== undefined && config.maxSpacesPerProfile > config.maxAgentWindows)
        ctx.addIssue({ code: 'custom', path: ['maxSpacesPerProfile'], message: 'must not exceed maxAgentWindows' })
    if (config.authMode === 'production') {
        if (config.trustedIssuers.length === 0) ctx.addIssue({ code: 'custom', path: ['trustedIssuers'], message: 'production needs at least one trusted issuer' })
        if (!config.daemonTokenSha256) ctx.addIssue({ code: 'custom', path: ['daemonTokenSha256'], message: 'production needs the daemon token hash' })
    }
})

export interface RuntimeConfig extends Omit<z.infer<typeof schema>, 'authMode' | 'machineId' | 'workspaceId' | 'trustedIssuers' | 'maxSpacesPerProfile'> {
    maxSpacesPerProfile: number
    authMode: AuthMode
    machineId: MachineId
    workspaceId: WorkspaceId
    trustedIssuers: TrustedIssuer[]
    profilePrincipals: ReadonlyMap<ProfileId, PrincipalId>
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
        // Issue messages are ours or zod's generic text; received values are never included.
        const detail = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code === 'unrecognized_keys' ? `unknown key(s) ${issue.keys.join(', ')}` : issue.message}`).join('; ')
        throw new Error(`ABP runtime config is invalid: ${detail}`)
    }
    const config = parsed.data
    return {
        ...config,
        maxSpacesPerProfile: config.maxSpacesPerProfile ?? Math.min(4, config.maxAgentWindows),
        machineId: config.machineId as MachineId,
        workspaceId: config.workspaceId as WorkspaceId,
        profilePrincipals: new Map(config.profiles.map((profile) => [profile.profileId as ProfileId, profile.principalId as PrincipalId])),
    }
}

export function loadRuntimeConfig(path: string): RuntimeConfig {
    let raw: unknown
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        throw new Error('ABP runtime config is unreadable or not JSON')
    }
    return parseRuntimeConfig(raw)
}
