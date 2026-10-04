/**
 * From packages/happy-cli:
 * pnpm exec tsx ../../specs/web-chat-latency-analysis/mcp-selected-runtime-benchmark.mts /absolute/result.json
 * Real local Codex app-server + one stdio MCP; no turn or provider request.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const output = process.argv[2];
assert.ok(output, 'An explicit result path is required');
const scratch = await mkdtemp(join(tmpdir(), 'codex-mcp-preparation-'));
process.env.HAPPY_HOME_DIR = join(scratch, 'happy');
process.env.CODEX_HOME = join(scratch, 'codex');
process.env.CODEX_MULTI_AUTH_DIR = join(scratch, 'no-rotation');
delete process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
delete process.env.DEBUG;
await mkdir(process.env.CODEX_HOME, { recursive: true });
await mkdir(join(scratch, 'workspace'));

// The fixture has no artificial delay and never invokes a remote service.
const fixture = join(scratch, 'mcp.cjs');
await writeFile(fixture, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  let result;
  switch(request.method) {
    case 'initialize': result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'benchmark', version: '1' } }; break;
    case 'tools/list': result = { tools: [{ name: 'probe', description: 'Local benchmark fixture', inputSchema: { type: 'object', properties: {} } }] }; break;
    case 'tools/call': result = { content: [{ type: 'text', text: 'OK' }] }; break;
    case 'ping': result = {}; break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported method' } }) + '\\n'); return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`);

const { CodexAppServerClient } = await import('../../packages/happy-cli/src/codex/codexAppServerClient');
const { CodexMcpRuntimeRecovery } = await import('../../packages/happy-cli/src/codex/codexMcpRuntimeRecovery');
const client = new CodexAppServerClient();
let inventoryCalls = 0;
let resumeCalls = 0;
let selected = false;
const recovery = new CodexMcpRuntimeRecovery({
    getMcpStartupStatuses: () => client.getMcpStartupStatuses(),
    listMcpServerStatus: async (input) => { inventoryCalls++; return client.listMcpServerStatus({ threadId: input.threadId, ...(selected ? { serverNames: ['benchmark'] } : {}) }); },
    resumeThread: async (input) => { resumeCalls++; return client.resumeThread(input); },
}, { connectorNames: [] });
const rows: Array<{ pair: number; condition: 'baseline' | 'treatment'; order: number; durationMs: number; inventoryCalls: number; resumeCalls: number; recovery: string; statuses: Array<{ name: string; status: string }> }> = [];
const median = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

try {
    const codexVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
    await client.connect();
    const mcpServers = { benchmark: { command: process.execPath, args: [fixture] } };
    const { threadId } = await client.startThread({ model: 'gpt-6-luna', cwd: join(scratch, 'workspace'), approvalPolicy: 'never', sandbox: 'read-only', mcpServers });
    const input = { threadId, mcpServers, expectedServerNames: ['benchmark'] };
    // Bootstrap excluded from the followup groups, verified with real inventory.
    assert.deepEqual((await recovery.readStatuses(input)).map(({ name, status }) => ({ name, status })), [{ name: 'benchmark', status: 'connected' }]);
    for (let pair = 1; pair <= 20; pair++) {
        const conditions = pair % 2 ? ['baseline', 'treatment'] as const : ['treatment', 'baseline'] as const;
        for (const [order, condition] of conditions.entries()) {
            selected = condition === 'treatment';
            const callsBefore = inventoryCalls;
            const resumesBefore = resumeCalls;
            const started = performance.now();
            const result = await recovery.recoverBeforeTurn({ ...input, includeRuntimeStatuses: true });
            const statuses = result.runtimeStatuses !== undefined
                ? result.runtimeStatuses
                : await recovery.readStatuses(input);
            const durationMs = performance.now() - started;
            rows.push({ pair, condition, order, durationMs, inventoryCalls: inventoryCalls - callsBefore, resumeCalls: resumeCalls - resumesBefore, recovery: result.status, statuses: statuses.map(({ name, status }) => ({ name, status })) });
        }
        if (pair % 5 === 0) console.log(JSON.stringify({ completedPairs: pair }));
    }
    const baseline = rows.filter(row => row.condition === 'baseline');
    const treatment = rows.filter(row => row.condition === 'treatment');
    const baselineMedianMs = median(baseline.map(row => row.durationMs));
    const treatmentMedianMs = median(treatment.map(row => row.durationMs));
    const baselineMadMs = median(baseline.map(row => Math.abs(row.durationMs - baselineMedianMs)));
    const thresholdMs = Math.max(10, 2 * baselineMadMs);
    const pairedDeltas = Array.from({ length: 20 }, (_, i) => baseline[i].durationMs - treatment[i].durationMs);
    const statusMismatch = rows.filter(row => JSON.stringify(row.statuses) !== JSON.stringify([{ name: 'benchmark', status: 'connected' }])).length;
    const failures = rows.filter(row => row.recovery !== 'ready').length;
    const result = {
        kind: 'real-local-codex-selected-runtime-inventory-paired-benchmark',
        date: new Date().toISOString().slice(0, 10),
        environment: { platform: process.platform, codexVersion, happySourceVersion: '1.1.10-aplus.286', scope: 'Isolated empty Codex/Happy homes, same thread and local stdio MCP; no credentials copied, no provider turn, no simulated RPC delay' },
        protocol: { pairs: 20, attempts: rows.length, firstThreadBootstrapExcluded: true, order: 'Alternating baseline/treatment and treatment/baseline', priorThreshold: 'max(10ms, 2*baseline MAD)', rawIdsAndContentExcluded: true, cleanupConfirmed: false },
        summary: { baselineMedianMs, treatmentMedianMs, baselineMadMs, thresholdMs, medianReductionMs: baselineMedianMs - treatmentMedianMs, medianReductionPercent: 100 * (baselineMedianMs - treatmentMedianMs) / baselineMedianMs, pairedReductionMedianMs: median(pairedDeltas), baselineInventoryCalls: baseline.reduce((n, row) => n + row.inventoryCalls, 0), treatmentInventoryCalls: treatment.reduce((n, row) => n + row.inventoryCalls, 0), recoveryFailures: failures, statusMismatch, resumeCalls: rows.reduce((n, row) => n + row.resumeCalls, 0), exploratoryTimeThresholdMet: median(pairedDeltas) > thresholdMs },
        limits: ['Local preparation-only scope; no Web/SDK-text/paint/ethan or model inference measurement.', 'No provider response or durable terminal was requested; not a Luna normal-response baseline.', 'Twenty pairs do not establish p95 or live authorization non-regression.'],
        rows,
    };
    await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n');
    assert.equal(failures, 0);
    assert.equal(statusMismatch, 0);
    assert.equal(result.summary.baselineInventoryCalls, 20);
    assert.equal(result.summary.treatmentInventoryCalls, 20);
    assert.equal(result.summary.resumeCalls, 0);
    console.log(JSON.stringify(result.summary));
} finally {
    await client.disconnect();
    // Codex may briefly leave its background plugin checkout writing files
    // after process exit. Retry removal of this benchmark's own scratch only.
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
const saved = JSON.parse(await readFile(resolve(output), 'utf8'));
saved.protocol.cleanupConfirmed = true;
await writeFile(resolve(output), JSON.stringify(saved, null, 2) + '\n');
