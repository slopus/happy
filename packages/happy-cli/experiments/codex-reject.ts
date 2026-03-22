/**
 * Codex MCP Client — permission REJECT experiment (legacy path).
 *
 * Connects to `codex mcp-server`, sends a prompt that triggers a permission
 * request, then REJECTS it (action: cancel) and verifies the callTool
 * resolves quickly (not hanging for 14 days).
 *
 * This tests the fix for the bug where Codex sends turn_aborted as a
 * notification but never sends the tool call response, causing callTool
 * to hang indefinitely.
 *
 * The fix: when turn_aborted is received, abort the controller to unblock
 * the pending callTool RPC.
 *
 * What this shows:
 * 1. Permission rejection can arrive as turn_aborted without a tool response
 * 2. Client-side abort on turn_aborted prevents hung callTool requests
 * 3. A reproducible regression test for reject-flow hangs
 *
 * Usage:
 *   npx tsx experiments/codex-reject.ts
 *   npx tsx experiments/codex-reject.ts "your prompt here"
 *   CWD=/some/project npx tsx experiments/codex-reject.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as z4mini from 'zod/v4-mini';
import { z } from 'zod';
import { execSync } from 'child_process';

// ── Config ──────────────────────────────────────────────────────────────────

const PROMPT = process.argv[2] || 'run: curl -s https://example.com | head -5';
const WORK_DIR = process.env.CWD || '/tmp';
const TIMEOUT = 30_000;

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

function buildCodexElicitRequestSchema() {
    const shape = (ElicitRequestSchema as any)._zod.def.shape;
    const unionOptions: any[] = shape.params._zod.def.options;
    const looseOptions = unionOptions.map((opt: any) => z4mini.looseObject(opt._zod.def.shape));
    return z4mini.object({
        method: shape.method,
        params: z4mini.union(looseOptions as [any, any, ...any[]]),
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const mcpCommand = getCodexMcpCommand();
    log('INIT', `codex ${mcpCommand} | prompt="${PROMPT}" | cwd=${WORK_DIR}`);

    const hardTimer = setTimeout(() => {
        log('FAIL', `>>> STILL BROKEN: callTool hung after permission rejection! <<<`);
        process.exit(1);
    }, TIMEOUT);

    // --- This mirrors the fix in runCodex.ts ---
    // We use an abort controller that gets aborted when turn_aborted fires.
    let abortController = new AbortController();

    const client = new Client(
        { name: 'codex-reject-experiment', version: '0.0.1' },
        { capabilities: { elicitation: {} } },
    );

    let elicitationCount = 0;
    let gotTurnAborted = false;

    // Listen for codex/event notifications
    client.setNotificationHandler(z.object({
        method: z.literal('codex/event'),
        params: z.object({ msg: z.any() }),
    }).passthrough(), (data) => {
        const msg = data.params.msg;
        const type = msg?.type ?? 'unknown';

        if (type === 'agent_reasoning_delta') {
            // skip
        } else if (type === 'agent_message') {
            log('MSG', msg.message);
        } else if (type === 'exec_command_begin') {
            log('EXEC', `$ ${msg.command}`);
        } else if (type === 'exec_command_end') {
            log('EXEC', `→ ${(msg.output || msg.error || '').slice(0, 200)}`);
        } else if (type === 'task_complete') {
            log('DONE', 'task_complete');
        } else if (type === 'turn_aborted') {
            gotTurnAborted = true;
            log('ABORT', 'turn_aborted received');

            // >>> THE FIX: abort the controller to unblock callTool <<<
            log('FIX', 'Aborting controller to unblock pending callTool');
            abortController.abort();
            abortController = new AbortController();
        } else if (type === 'exec_approval_request') {
            log('PERM_EVENT', `exec_approval_request: ${JSON.stringify(msg).slice(0, 150)}`);
        } else {
            // quiet
        }
    });

    // Reject all permission requests with cancel (abort)
    const CodexElicitSchema = buildCodexElicitRequestSchema();
    client.setRequestHandler(CodexElicitSchema as any, async (request: any) => {
        elicitationCount++;
        const params = request.params;
        log('PERM', `#${elicitationCount} call_id=${params?.codex_call_id ?? '<missing>'}`);
        log('PERM', `  command: ${JSON.stringify(params?.codex_command ?? [])}`);
        log('PERM', `  → Rejecting with action=cancel`);
        return { action: 'cancel' as const, decision: 'abort' as const };
    });

    const transport = new StdioClientTransport({
        command: 'codex',
        args: [mcpCommand],
    });

    log('CONNECT', 'Connecting...');
    await client.connect(transport);
    log('CONNECT', 'Connected');

    const callStart = Date.now();
    let error: any = null;
    try {
        await client.callTool({
            name: 'codex',
            arguments: {
                prompt: PROMPT,
                'approval-policy': 'untrusted',
                sandbox: 'workspace-write',
                cwd: WORK_DIR,
            },
        }, undefined, {
            signal: abortController.signal,
            timeout: TIMEOUT - 5000,
        });
    } catch (err: any) {
        error = err;
    }

    const elapsed = Date.now() - callStart;
    clearTimeout(hardTimer);

    // ── Results ──────────────────────────────────────────────────────────
    log('RESULT', '═══════════════════════════════════════');
    log('RESULT', `Permission requests: ${elicitationCount}`);
    log('RESULT', `turn_aborted: ${gotTurnAborted}`);
    log('RESULT', `callTool elapsed: ${elapsed}ms`);
    log('RESULT', `error: ${error ? `${error.name}: ${error.message}` : 'none (resolved normally)'}`);

    const passed = gotTurnAborted && elapsed < 20_000;
    if (passed) {
        log('PASS', `Fix works! callTool unblocked in ${elapsed}ms after turn_aborted`);
    } else if (!gotTurnAborted) {
        log('FAIL', 'No turn_aborted received — permission may not have been triggered');
    } else {
        log('FAIL', `callTool took ${elapsed}ms — still hanging after turn_aborted`);
    }

    // Cleanup
    try { await client.close(); } catch {}
    const pid = (transport as any).pid;
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }

    process.exit(passed ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
