import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { registerHappyBridgeTools } from './happyMcpBridgeTools';
import { withHappyMcpSchemaProfile, type HappyMcpSchemaProfile } from './happyMcpSchemaProfile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function connect(profile?: HappyMcpSchemaProfile) {
  const forwarded: unknown[] = [];
  const server = new McpServer({ name: 'schema-profile-test', version: '1.0.0' });
  // Only the external HTTP endpoint is replaced. Registration and both Zod
  // validation layers execute through the real MCP server and client.
  registerHappyBridgeTools(server, async () => ({ callTool: async (request: unknown) => {
    forwarded.push(request);
    return { content: [{ type: 'text', text: 'forwarded' }] };
  } }) as unknown as Client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(withHappyMcpSchemaProfile(serverTransport, profile));
  cleanups.push(() => server.close());
  const client = new Client({ name: 'schema-profile-client', version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(clientTransport);
  return { client, forwarded };
}

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
