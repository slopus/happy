/**
 * Manual/agent-run helper: `tsx src/browserRuntime/e2e/stackCli.ts up <run>` brings a
 * stack up and prints non-secret connection info; `grant <run> <agentSessionId> <file>`
 * writes an agent grant token to <file> (mode 0600); `down <run>` removes it.
 * Keys stay in scripts/browser-poc/.abp/<run>/keys.json (harness-only).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mintAgentGrant } from '../auth'
import { AGENT_OPERATIONS, type AgentSessionId, type GrantId } from '../contracts'
import { MACHINE, PRINCIPAL_A, PROFILE_A, SITE_A, SITE_B, WORKSPACE, startPocStack } from './pocStack'

const [cmd, run, ...rest] = process.argv.slice(2)
const runDir = join(import.meta.dirname, '../../../scripts/browser-poc/.abp', run ?? '')

if (cmd === 'up') {
    process.env.ABP_KEEP_STACK = '1'
    const stack = await startPocStack({ run })
    console.log(JSON.stringify({ run: stack.run, runtimeUrl: stack.runtimeUrl, ports: stack.env.ports }))
} else if (cmd === 'grant') {
    const [agentSessionId, file, ttlMin = '60'] = rest
    const keys = JSON.parse(readFileSync(join(runDir, 'keys.json'), 'utf8'))
    const now = Date.now()
    const grantId = `grant-${run}-${now}` as GrantId
    const token = mintAgentGrant({
        kind: 'agent-grant', grantId, principalId: PRINCIPAL_A, workspaceId: WORKSPACE, machineId: MACHINE,
        agentSessionId: agentSessionId as AgentSessionId, profileId: PROFILE_A, allowedOrigins: [SITE_A, SITE_B],
        operations: [...AGENT_OPERATIONS], taskSpaceIds: [], issuedAtMs: now, expiresAtMs: now + Number(ttlMin) * 60_000,
    }, keys, now)
    writeFileSync(file, token, { mode: 0o600 })
    console.log(JSON.stringify({ grantId, file }))
} else if (cmd === 'down') {
    const { execFileSync } = await import('node:child_process')
    execFileSync('node', [join(import.meta.dirname, '../../../scripts/browser-poc/poc.mjs'), 'down', '--run', run, '--purge'], { stdio: 'inherit' })
} else {
    console.error('usage: up <run> | grant <run> <agentSessionId> <file> [ttlMin] | down <run>')
    process.exit(2)
}
