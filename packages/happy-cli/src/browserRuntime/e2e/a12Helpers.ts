import { randomUUID } from 'node:crypto'
import { mintAgentGrant } from '../auth'
import { AGENT_OPERATIONS, type AgentSessionId, type GrantId } from '../contracts'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE, type PocStack } from './pocStack'

/** Issue a grant with a short clock-skew margin across macOS and Linux containers. */
export function a12Grant(stack: PocStack): string {
    const now = Date.now()
    return mintAgentGrant({
        kind: 'agent-grant', grantId: `a12-${randomUUID()}` as GrantId,
        principalId: PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE,
        agentSessionId: `a12-${randomUUID()}` as AgentSessionId,
        profileId: PROFILE_A, allowedOrigins: [SITE_A, SITE_B],
        operations: [...AGENT_OPERATIONS], taskSpaceIds: [],
        issuedAtMs: now - 5_000, expiresAtMs: now + 30 * 60_000,
    }, stack.keys, now)
}
