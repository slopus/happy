import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { registerHappyBridgeTools } from './happyMcpBridgeTools';
import { withHappyMcpSchemaProfile, type HappyMcpSchemaProfile } from './happyMcpSchemaProfile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function connect(profile?: HappyMcpSchemaProfile) {
  const forwarded: unknown[] = [];
  const received: JSONRPCMessage[] = [];
  const sent: JSONRPCMessage[] = [];
  const server = new McpServer({ name: 'schema-profile-test', version: '1.0.0' });
  // Only the external HTTP endpoint is replaced. Registration and both Zod
  // validation layers execute through the real MCP server and client.
  registerHappyBridgeTools(server, async () => ({ callTool: async (request: unknown) => {
    forwarded.push(request);
    return { content: [{ type: 'text', text: 'forwarded' }] };
  } }) as unknown as Client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const profiled = withHappyMcpSchemaProfile(serverTransport, profile);
  profiled.onmessage = message => { received.push(structuredClone(message)); };
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (message, options) => { sent.push(structuredClone(message)); await send(message, options); };
  await server.connect(profiled);
  cleanups.push(() => server.close());
  const client = new Client({ name: 'schema-profile-client', version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(clientTransport);
  return { client, forwarded, received, sent };
}

const delegateArgs = { requestId: 'payload-request', intent: 'explicit', route: { agent: 'antigravity' },
  title: 'Review', prompt: 'Review "quotes"\n第二行', context: 'Only this scope' };

function catalog() {
  return { tools: [{ name: 'agent_roles', inputSchema: { type: 'object', properties: {
    patch: { type: 'object', properties: {
      model: { anyOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'null' }] },
      effort: { anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] },
    } },
  } } }] };
}
const request = (id: string | number, method = 'tools/list'): JSONRPCMessage => ({ jsonrpc: '2.0', id, method });
const response = (id: string | number): JSONRPCMessage => ({ jsonrpc: '2.0', id, result: catalog() });
const modelSchema = (message: JSONRPCMessage) => (message as any).result.tools[0].inputSchema.properties.patch.properties.model;

class RecordingTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  messages: JSONRPCMessage[] = [];
  failSend = false;
  failStart = false;
  async start() {
    if (this.failStart) { this.onmessage?.(request('early')); throw new Error('start failed'); }
  }
  async close() { this.onclose?.(); }
  async send(message: JSONRPCMessage) {
    if (this.failSend) throw new Error('send failed');
    this.messages.push(message);
  }
}

async function recording() {
  const inner = new RecordingTransport();
  const transport = withHappyMcpSchemaProfile(inner, 'antigravity');
  await transport.start();
  cleanups.push(() => transport.close());
  return { inner, transport };
}

describe('AGY MCP schema profile through the real SDK', () => {
  it('exports only a strict payload wrapper for AGY delegation and retains the canonical default schema', async () => {
    const ordinary = await connect();
    const agy = await connect('antigravity');
    const original = (await ordinary.client.listTools()).tools.find(tool => tool.name === 'delegate_task')!;
    const compatible = (await agy.client.listTools()).tools.find(tool => tool.name === 'delegate_task')!;
    expect(original.inputSchema.properties).toHaveProperty('requestId');
    expect(original.inputSchema.properties).not.toHaveProperty('payload');
    expect(compatible).toEqual({ ...original, inputSchema: { type: 'object', properties: { payload: { type: 'string',
      description: 'JSON object containing the canonical delegate_task arguments (requestId,intent,prompt and exactly one roleId/taskId/route); model/effort optional.',
    } }, required: ['payload'], additionalProperties: false } });
  });

  it('unwraps the exact payload and preserves request identity and metadata before the original validator', async () => {
    const { client, forwarded, received, sent } = await connect('antigravity');
    const result = await client.callTool({ name: 'delegate_task', arguments: { payload: JSON.stringify(delegateArgs) },
      _meta: { progressToken: 'payload-progress', trace: 'keep-this-metadata' } });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'forwarded' }] });
    expect(forwarded).toEqual([{ name: 'delegate_task', arguments: delegateArgs }]);
    const original = sent.find(message => 'method' in message && message.method === 'tools/call') as any;
    const decoded = received.find(message => 'method' in message && message.method === 'tools/call') as any;
    expect(decoded.id).toBe(original.id);
    expect(decoded.params).toEqual({ ...original.params, arguments: delegateArgs });
    expect(original.params.arguments).toEqual({ payload: JSON.stringify(delegateArgs) });
  });

  it('continues accepting canonical AGY arguments without adding a payload requirement to runtime validation', async () => {
    const { client, forwarded } = await connect('antigravity');
    expect(await client.callTool({ name: 'delegate_task', arguments: delegateArgs })).toMatchObject({ content: [{ text: 'forwarded' }] });
    expect(forwarded).toEqual([{ name: 'delegate_task', arguments: delegateArgs }]);
  });

  it('leaves a default bridge payload untouched for the original validator to reject', async () => {
    const { client, forwarded, received } = await connect();
    const args = { payload: JSON.stringify(delegateArgs) };
    expect(await client.callTool({ name: 'delegate_task', arguments: args })).toMatchObject({ isError: true });
    expect(forwarded).toEqual([]);
    expect((received.find(message => 'method' in message && message.method === 'tools/call') as any).params.arguments).toEqual(args);
  });

  it.each<[string, Record<string, unknown>]>([
    ['invalid JSON', { payload: '{' }],
    ['null JSON', { payload: 'null' }],
    ['array JSON', { payload: '[]' }],
    ['string JSON', { payload: '"text"' }],
    ['number JSON', { payload: '42' }],
    ['boolean JSON', { payload: 'true' }],
    ['non-string payload', { payload: delegateArgs }],
    ['extra outer field', { payload: JSON.stringify(delegateArgs), unexpected: true }],
    ['outer metadata is not a business field', { payload: JSON.stringify(delegateArgs), toolSummary: 'Not an MCP argument' }],
    ['outer intent must not override the payload', { payload: JSON.stringify({ ...delegateArgs, intent: 'automatic' }), intent: 'explicit' }],
  ])('rejects %s without rewriting the malformed wrapper or forwarding', async (_label, args) => {
    const { client, forwarded, received } = await connect('antigravity');
    expect(await client.callTool({ name: 'delegate_task', arguments: args })).toMatchObject({ isError: true });
    expect(forwarded).toEqual([]);
    expect((received.find(message => 'method' in message && message.method === 'tools/call') as any).params.arguments).toEqual(args);
  });

  it.each<[string, Record<string, unknown>]>([
    ['missing requestId', { intent: 'explicit', route: { agent: 'antigravity' }, prompt: 'Review' }],
    ['empty requestId', { ...delegateArgs, requestId: '' }],
    ['missing intent', { requestId: 'r', route: { agent: 'antigravity' }, prompt: 'Review' }],
    ['invalid intent', { ...delegateArgs, intent: 'human-approved' }],
    ['automatic temporary route', { ...delegateArgs, intent: 'automatic' }],
    ['conflicting targets', { ...delegateArgs, roleId: 'writer' }],
    ['invalid route', { ...delegateArgs, route: { agent: 'unknown' } }],
    ['unknown root field', { ...delegateArgs, parentSessionId: 'another-session' }],
    ['nested wrapper', { payload: JSON.stringify(delegateArgs) }],
  ])('preserves the canonical validator rejection for %s after decoding', async (_label, canonical) => {
    const { client, forwarded } = await connect('antigravity');
    expect(await client.callTool({ name: 'delegate_task', arguments: { payload: JSON.stringify(canonical) } })).toMatchObject({ isError: true });
    expect(forwarded).toEqual([]);
  });

  it.each(['agent_roles', 'mcp_happy_delegate_task', 'delegate_task_extra'])('does not unwrap a different tool identity: %s', async name => {
    const { client, forwarded, received } = await connect('antigravity');
    const args = { payload: JSON.stringify(name === 'agent_roles' ? { action: 'list' } : delegateArgs) };
    expect(await client.callTool({ name, arguments: args })).toMatchObject({ isError: true });
    expect(forwarded).toEqual([]);
    expect((received.find(message => 'method' in message && message.method === 'tools/call') as any).params.arguments).toEqual(args);
  });

  it('accepts valid worst-case escaped prompt and context within the bounded payload', async () => {
    const { client, forwarded } = await connect('antigravity');
    const args = { requestId: 'large-valid', intent: 'explicit', route: { agent: 'antigravity' },
      prompt: '\u0000'.repeat(100_000), context: '\u0000'.repeat(100_000) };
    const payload = JSON.stringify(args);
    expect(payload.length).toBeGreaterThan(1_200_000);
    expect(payload.length).toBeLessThan(2 * 1024 * 1024);
    const result = await client.callTool({ name: 'delegate_task', arguments: { payload } });
    expect(result.isError).not.toBe(true);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(forwarded).toHaveLength(1);
    const actual = (forwarded[0] as { arguments: typeof args }).arguments;
    expect(digest(actual.prompt)).toBe(digest(args.prompt));
    expect(digest(actual.context)).toBe(digest(args.context));
  });

  it('rejects an oversized wrapper without forwarding even when its JSON would decode to valid arguments', async () => {
    const { client, forwarded } = await connect('antigravity');
    const payload = ' '.repeat(2 * 1024 * 1024) + JSON.stringify(delegateArgs);
    expect(await client.callTool({ name: 'delegate_task', arguments: { payload } })).toMatchObject({ isError: true });
    expect(forwarded).toEqual([]);
  });

  it('bounds UTF-8 bytes rather than only JavaScript character count', async () => {
    const { client, forwarded } = await connect('antigravity');
    const args = { ...delegateArgs, prompt: '中'.repeat(100_000), context: '中'.repeat(100_000) };
    const payload = ' '.repeat(1_600_000) + JSON.stringify(args);
    expect(payload.length).toBeLessThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(2 * 1024 * 1024);
    expect(await client.callTool({ name: 'delegate_task', arguments: { payload } })).toMatchObject({ isError: true });
    expect(forwarded).toEqual([]);
  });

  it('keeps the same SDK connection usable after malformed JSON is rejected', async () => {
    const { client, forwarded } = await connect('antigravity');
    expect(await client.callTool({ name: 'delegate_task', arguments: { payload: '{' } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: 'delegate_task', arguments: { payload: JSON.stringify(delegateArgs) } }))
      .toMatchObject({ content: [{ text: 'forwarded' }] });
    expect(forwarded).toEqual([{ name: 'delegate_task', arguments: delegateArgs }]);
  });

  it('normalizes only the listed nullable role fields over an in-memory protocol connection', async () => {
    const { client } = await connect('antigravity');
    const tools = await client.listTools();
    const patch = (tools.tools.find(tool => tool.name === 'agent_roles')!.inputSchema.properties as any).patch.properties;
    expect(patch.model).toEqual({ type: ['string', 'null'], minLength: 1, maxLength: 256 });
    expect(patch.effort).toEqual({ type: ['string', 'null'], minLength: 1, maxLength: 100 });
  });

  it('forwards null resets unchanged through the original runtime validators and handler', async () => {
    const { client, forwarded } = await connect('antigravity');
    const result = await client.callTool({ name: 'agent_roles', arguments: {
      action: 'update', roleId: 'writer', patch: { model: null, effort: null },
    } });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'forwarded' }] });
    expect(forwarded).toEqual([{ name: 'agent_roles', arguments: { action: 'update', roleId: 'writer', patch: { model: null, effort: null } } }]);
  });

  it.each([
    { action: 'update', roleId: 'writer', patch: { model: 42 } },
    { action: 'update', roleId: 'writer', patch: { effort: '' } },
    { action: 'update', roleId: 'writer', patch: { unexpected: 'field' } },
    { action: 'list', patch: { model: null } },
  ])('keeps the runtime contract strict after schema normalization: %j', async args => {
    const { client, forwarded } = await connect('antigravity');
    expect(await client.callTool({ name: 'agent_roles', arguments: args })).toMatchObject({ isError: true });
    expect(forwarded).toEqual([]);
  });
});

describe('schema profile JSON-RPC fences and lifecycle', () => {
  it('matches the original ID type and consumes the tools/list correlation exactly once', async () => {
    const { inner, transport } = await recording();
    inner.onmessage?.(request(1));
    await transport.send(response('1'));
    await transport.send(response(1));
    await transport.send(response(1));
    expect(modelSchema(inner.messages[0])).toHaveProperty('anyOf');
    expect(modelSchema(inner.messages[1])).toEqual({ type: ['string', 'null'], minLength: 1, maxLength: 256 });
    expect(modelSchema(inner.messages[2])).toHaveProperty('anyOf');
  });

  it('does not transform another RPC result even when its payload looks like a tool catalog', async () => {
    const { inner, transport } = await recording();
    inner.onmessage?.(request('call', 'tools/call'));
    const original = response('call');
    await transport.send(original);
    expect(inner.messages).toEqual([original]);
  });

  it('clears correlation if the same ID is reused for a non-list request', async () => {
    const { inner, transport } = await recording();
    inner.onmessage?.(request('same'));
    inner.onmessage?.(request('same', 'tools/call'));
    await transport.send(response('same'));
    expect(modelSchema(inner.messages[0])).toHaveProperty('anyOf');
  });

  it.each(['error', 'cancel', 'close'])('clears a pending list after %s', async terminal => {
    const { inner, transport } = await recording();
    inner.onmessage?.(request('ended'));
    if (terminal === 'error') await transport.send({ jsonrpc: '2.0', id: 'ended', error: { code: -32603, message: 'failed' } });
    if (terminal === 'cancel') inner.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'ended' } });
    if (terminal === 'close') await transport.close();
    await transport.send(response('ended'));
    expect(modelSchema(inner.messages.at(-1)!)).toHaveProperty('anyOf');
  });

  it('clears the response correlation before a failed transport send', async () => {
    const { inner, transport } = await recording();
    inner.onmessage?.(request('failed-send'));
    inner.failSend = true;
    await expect(transport.send(response('failed-send'))).rejects.toThrow('send failed');
    inner.failSend = false;
    await transport.send(response('failed-send'));
    expect(modelSchema(inner.messages[0])).toHaveProperty('anyOf');
  });

  it('clears an early list request when transport startup fails', async () => {
    const inner = new RecordingTransport();
    inner.failStart = true;
    const transport = withHappyMcpSchemaProfile(inner, 'antigravity');
    await expect(transport.start()).rejects.toThrow('start failed');
    await transport.send(response('early'));
    expect(modelSchema(inner.messages[0])).toHaveProperty('anyOf');
  });

  it('leaves future branch constraints intact rather than changing the meaning of null', async () => {
    const { inner, transport } = await recording();
    inner.onmessage?.(request('future'));
    const original = response('future');
    (modelSchema(original).anyOf[0] as Record<string, unknown>).enum = ['neon'];
    await transport.send(original);
    expect(modelSchema(inner.messages[0])).toEqual({ anyOf: [{ type: 'string', minLength: 1, maxLength: 256, enum: ['neon'] }, { type: 'null' }] });
  });

  it('bounds outstanding list correlations and admits another list after a response frees capacity', async () => {
    const { inner, transport } = await recording();
    const delivered: JSONRPCMessage[] = [];
    transport.onmessage = message => { delivered.push(message); };
    for (let id = 0; id <= 64; id++) inner.onmessage?.(request(id));
    expect(delivered).toHaveLength(64);
    expect(inner.messages[0]).toMatchObject({ id: 64, error: { code: -32603 } });
    await transport.send(response(0));
    inner.onmessage?.(request(64));
    await transport.send(response(64));
    expect(modelSchema(inner.messages.at(-1)!)).toEqual({ type: ['string', 'null'], minLength: 1, maxLength: 256 });
  });
});
