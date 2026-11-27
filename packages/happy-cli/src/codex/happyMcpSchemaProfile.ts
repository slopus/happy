import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';

export type HappyMcpSchemaProfile = 'antigravity';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** AGY accepts these nullable role-patch fields as a draft-7 type array.
 * String-only constraints retain their meaning with type:[string,null]. Do not
 * flatten enum/const or future branch constraints, which could exclude null. */
function nullableStringType(schema: unknown): unknown {
  const node = record(schema);
  if (!node || Object.keys(node).length !== 1 || !Array.isArray(node.anyOf) || node.anyOf.length !== 2) return schema;
  const string = record(node.anyOf[0]);
  const nil = record(node.anyOf[1]);
  if (string?.type !== 'string' || nil?.type !== 'null' || Object.keys(nil).length !== 1
    || !Object.keys(string).every(key => ['type', 'minLength', 'maxLength'].includes(key))) return schema;
  for (const key of ['minLength', 'maxLength']) {
    if (key in string && (!Number.isInteger(string[key]) || Number(string[key]) < 0)) return schema;
  }
  return { ...string, type: ['string', 'null'] };
}

function normalizeProfileTool(tool: unknown): unknown {
  const entry = record(tool);
  if (entry?.name === 'delegate_task') return { ...entry, inputSchema: {
    type: 'object', properties: { payload: { type: 'string',
      description: 'JSON object containing the canonical delegate_task arguments (requestId,intent,prompt and exactly one roleId/taskId/route); model/effort optional.',
    } }, required: ['payload'], additionalProperties: false,
  } };
  if (entry?.name !== 'agent_roles') return tool;
  const input = record(entry.inputSchema);
  const properties = record(input?.properties);
  const patch = record(properties?.patch);
  const fields = record(patch?.properties);
  if (!input || !properties || !patch || !fields) return tool;
  const model = nullableStringType(fields.model);
  const effort = nullableStringType(fields.effort);
  if (model === fields.model && effort === fields.effort) return tool;
  return { ...entry, inputSchema: { ...input, properties: { ...properties,
    patch: { ...patch, properties: { ...fields, model, effort } },
  } } };
}

function normalizeToolList(message: JSONRPCMessage): JSONRPCMessage {
  if (!('result' in message)) return message;
  const result = record(message.result);
  if (!result || !Array.isArray(result.tools)) return message;
  return { ...message, result: { ...result, tools: result.tools.map(normalizeProfileTool) } };
}

function unwrapDelegatePayload(message: JSONRPCMessage): JSONRPCMessage {
  if (!('method' in message) || message.method !== 'tools/call' || !('id' in message)
    || (typeof message.id !== 'string' && typeof message.id !== 'number')) return message;
  const params = record(message.params);
  const args = record(params?.arguments);
  if (params?.name !== 'delegate_task' || !args || Reflect.ownKeys(args).length !== 1
    || !Object.hasOwn(args, 'payload') || typeof args.payload !== 'string'
    || Buffer.byteLength(args.payload, 'utf8') > 2 * 1024 * 1024) return message;
  try {
    const canonical = record(JSON.parse(args.payload));
    return canonical ? { ...message, params: { ...params, arguments: canonical } } : message;
  } catch {
    // Malformed wrappers reach the original strict validator unchanged. Its
    // normal error response keeps the connection alive; no defaults or merging.
    return message;
  }
}

/** Decorates only AGY STDIO. The payload adapter precedes the unchanged SDK/Zod
 * validators; registration, HTTP and default bridges use the canonical contract. */
export function withHappyMcpSchemaProfile(inner: Transport, profile?: HappyMcpSchemaProfile): Transport {
  if (profile === undefined) return inner;
  if (profile !== 'antigravity') throw new Error('Unknown MCP schema profile');
  const pending = new Set<RequestId>();
  const wrapper: Transport = {
    get sessionId() { return inner.sessionId; },
    setProtocolVersion(version) { inner.setProtocolVersion?.(version); },
    async start() {
      inner.onmessage = (message, extra) => {
        if ('method' in message) {
          if ('id' in message) {
            pending.delete(message.id);
            if (message.method === 'tools/list') {
              // Bound memory even if a peer sends requests faster than replies.
              if (pending.size >= 64) {
                void inner.send({ jsonrpc: '2.0', id: message.id, error: {
                  code: -32603, message: 'Too many outstanding tools/list requests',
                } }).catch(error => wrapper.onerror?.(error));
                return;
              }
              pending.add(message.id);
            }
          }
          if (message.method === 'notifications/cancelled') {
            const id = record(message.params)?.requestId;
            if (typeof id === 'string' || typeof id === 'number') pending.delete(id);
          }
        }
        wrapper.onmessage?.(unwrapDelegatePayload(message), extra);
      };
      inner.onerror = error => wrapper.onerror?.(error);
      inner.onclose = () => { pending.clear(); wrapper.onclose?.(); };
      try { await inner.start(); } catch (error) { pending.clear(); throw error; }
    },
    async send(message, options) {
      // Consume both success and error responses before I/O, including failures.
      const id = 'id' in message ? message.id : undefined;
      const listed = !('method' in message) && (typeof id === 'string' || typeof id === 'number') && pending.delete(id);
      await inner.send(listed ? normalizeToolList(message) : message, options);
    },
    async close() { pending.clear(); await inner.close(); },
  };
  return wrapper;
}
