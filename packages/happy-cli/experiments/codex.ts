/**
 * Codex MCP Client exploration script.
 *
 * Connects to `codex mcp-server` directly (no daemon, no API, no session),
 * sends a prompt, auto-approves permission requests, and prints all events.
 *
 * Usage:
 *   npx tsx experiments/codex.ts
 *   npx tsx experiments/codex.ts "your prompt here"
 *   CWD=/some/project npx tsx experiments/codex.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as z4mini from 'zod/v4-mini';
import { z } from 'zod';
import { execSync } from 'child_process';

// ── Config ──────────────────────────────────────────────────────────────────

const PROMPT = process.argv[2] || 'curl google home page';
const WORK_DIR = process.env.CWD || '/Users/kirilldubovitskiy/projects/happy/happy/packages/happy-cli/demo-project';
const TIMEOUT = 60_000; // 60s hard timeout for the whole run
// 'on-request' triggers elicitation for commands; 'never' auto-approves everything
const APPROVAL_POLICY: 'untrusted' | 'on-failure' | 'on-request' | 'never' = 'on-request';
// 'read-only' + 'on-request' should trigger permission prompts for network/write commands
const SANDBOX: 'read-only' | 'workspace-write' | 'danger-full-access' = 'read-only';

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(tag: string, ...args: unknown[]) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] [${tag}]`, ...args);
}

function getCodexMcpCommand(): string {
    const version = execSync('codex --version', { encoding: 'utf8' }).trim();
    const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
    if (!match) throw new Error(`Cannot parse codex version: ${version}`);
    const [major, minor] = match[1].split(/[-.]/).map(Number);
    return (major > 0 || minor >= 43) ? 'mcp-server' : 'mcp';
}

/**
 * Build a passthrough version of ElicitRequestSchema.
 * The stock MCP SDK schema strips unknown params (like codex_call_id).
 * We rebuild the params union with looseObject so they survive.
 */
function buildCodexElicitRequestSchema() {
    const shape = (ElicitRequestSchema as any)._zod.def.shape;
    const unionOptions: any[] = shape.params._zod.def.options;
    const looseOptions = unionOptions.map((opt: any) => z4mini.looseObject(opt._zod.def.shape));
    // Reuse the original method literal — Client.setRequestHandler checks `def.value`
    // but z4mini.literal only has `def.values`, so using the original avoids the mismatch.
    return z4mini.object({
        method: shape.method,
        params: z4mini.union(looseOptions as [any, any, ...any[]]),
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const mcpCommand = getCodexMcpCommand();
    log('INIT', `codex ${mcpCommand} | prompt="${PROMPT}" | cwd=${WORK_DIR}`);

    // Hard timeout
    const hardTimer = setTimeout(() => {
        log('TIMEOUT', `Hard timeout (${TIMEOUT}ms) reached, exiting`);
        process.exit(1);
    }, TIMEOUT);

    const client = new Client(
        { name: 'codex-experiment', version: '0.0.1' },
        { capabilities: { elicitation: {} } },
    );

    // Track permission requests for debugging
    let elicitationCount = 0;

    // Listen for codex/event notifications
    client.setNotificationHandler(z.object({
        method: z.literal('codex/event'),
        params: z.object({ msg: z.any() }),
    }).passthrough(), (data) => {
        const msg = data.params.msg;
        const type = msg?.type ?? 'unknown';

        if (type === 'agent_reasoning_delta') {
            process.stdout.write(msg.delta ?? '');
        } else if (type === 'agent_message') {
            log('MSG', msg.message);
        } else if (type === 'exec_command_begin') {
            log('EXEC', `$ ${msg.command}`);
        } else if (type === 'exec_command_end') {
            const out = (msg.output || msg.error || '').slice(0, 300);
            log('EXEC', `→ ${out}`);
        } else if (type === 'task_complete') {
            log('DONE', 'task_complete');
        } else if (type === 'turn_aborted') {
            log('ABORT', 'turn_aborted');
        } else {
            log('EVENT', type, JSON.stringify(msg).slice(0, 200));
        }
    });

    // Register elicitation handler (permission approval)
    const CodexElicitSchema = buildCodexElicitRequestSchema();
    client.setRequestHandler(CodexElicitSchema as any, async (request: any) => {
        elicitationCount++;
        const params = request.params;
        const callId = params?.codex_call_id ?? '<missing>';
        const cmd = params?.codex_command ?? [];
        const cwd = params?.codex_cwd ?? '<unknown>';

        log('PERM', `#${elicitationCount} call_id=${callId}`);
        log('PERM', `  command: ${JSON.stringify(cmd)}`);
        log('PERM', `  cwd: ${cwd}`);
        log('PERM', `  message: ${(params?.message ?? '').slice(0, 120)}`);

        // Verify codex_call_id is NOT stripped
        if (!params?.codex_call_id) {
            log('BUG', 'codex_call_id is MISSING — schema passthrough is broken!');
            return { action: 'decline' as const };
        }

        log('PERM', '→ auto-approving');
        // MCP elicitation expects `action` ('accept'|'decline'|'cancel').
        // Codex also reads a custom `decision` field from the response.
        return { action: 'accept' as const, decision: 'approved' as const };
    });

    // Create transport
    const transport = new StdioClientTransport({
        command: 'codex',
        args: [mcpCommand],
    });

    log('CONNECT', 'Connecting to codex MCP server...');
    await client.connect(transport);
    log('CONNECT', 'Connected');

    // Send prompt
    log('SEND', `Calling codex tool with prompt: "${PROMPT}"`);
    try {
        const response = await client.callTool({
            name: 'codex',
            arguments: {
                prompt: PROMPT,
                'approval-policy': APPROVAL_POLICY,
                sandbox: SANDBOX,
                cwd: WORK_DIR,
            },
        }, undefined, {
            timeout: TIMEOUT - 5000,
        });

        log('RESPONSE', JSON.stringify(response).slice(0, 500));
    } catch (err) {
        log('ERROR', err);
    }

    // Cleanup
    clearTimeout(hardTimer);
    log('CLEANUP', 'Closing client...');
    try {
        await client.close();
    } catch {}

    const pid = (transport as any).pid;
    if (pid) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
    }

    log('EXIT', `Done. ${elicitationCount} permission requests handled.`);
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
