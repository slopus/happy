import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function bridge(args: string[] = []) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', require.resolve('tsx'), join(cliRoot, 'src/codex/happyMcpStdioBridge.ts'),
      '--url', 'http://127.0.0.1:1', ...args], cwd: cliRoot, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'schema-profile-test', version: '1.0.0' });
  cleanups.push(() => client.close());
  return { client, transport, stderr: () => stderr };
}

describe('Happy MCP schema profiles through real STDIO', () => {
  it('exports AGY role fields and the delegation payload schema while leaving other tools and the default catalog unchanged', async () => {
    const ordinary = bridge();
    await ordinary.client.connect(ordinary.transport);
    const original = await ordinary.client.listTools();
    const agy = bridge(['--schema-profile', 'antigravity']);
    await agy.client.connect(agy.transport);
    const compatible = await agy.client.listTools();
    const role = (catalog: typeof original) => catalog.tools.find(tool => tool.name === 'agent_roles')!;
    const patch = (catalog: typeof original) => (role(catalog).inputSchema.properties as any).patch.properties;

    expect(patch(original).model).toEqual({ anyOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'null' }] });
    expect(patch(original).effort).toEqual({ anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] });
    expect(patch(compatible).model).toEqual({ type: ['string', 'null'], minLength: 1, maxLength: 256 });
    expect(patch(compatible).effort).toEqual({ type: ['string', 'null'], minLength: 1, maxLength: 100 });
    const unchangedRole = structuredClone(role(original));
    (unchangedRole.inputSchema.properties as any).patch.properties.model = { type: ['string', 'null'], minLength: 1, maxLength: 256 };
    (unchangedRole.inputSchema.properties as any).patch.properties.effort = { type: ['string', 'null'], minLength: 1, maxLength: 100 };
    expect(role(compatible)).toEqual(unchangedRole);
    const delegate = (catalog: typeof original) => catalog.tools.find(tool => tool.name === 'delegate_task')!;
    expect(delegate(original).inputSchema.properties).toHaveProperty('requestId');
    expect(delegate(original).inputSchema.properties).not.toHaveProperty('payload');
    expect(delegate(compatible)).toEqual({ ...delegate(original), inputSchema: { type: 'object', properties: { payload: { type: 'string',
      description: 'JSON object containing the canonical delegate_task arguments (requestId,intent,prompt and exactly one roleId/taskId/route); model/effort optional.',
    } }, required: ['payload'], additionalProperties: false } });
    const otherTools = (catalog: typeof original) => catalog.tools.filter(tool => !['agent_roles', 'delegate_task'].includes(tool.name));
    expect(otherTools(compatible)).toEqual(otherTools(original));
  });

  it.each([{ args: ['--schema-profile', 'unknown'] }, { args: ['--schema-profile'] }])('rejects an unsupported or missing profile before accepting a connection: %j', async ({ args }) => {
    const instance = bridge(args);
    await expect(instance.client.connect(instance.transport)).rejects.toThrow(/Connection closed/i);
    expect(instance.stderr()).toMatch(/schema profile/i);
  });
});
