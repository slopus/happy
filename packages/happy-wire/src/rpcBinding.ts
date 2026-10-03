import * as z from 'zod';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R18 — what a
 * customer-lane RPC vouches for besides its params.
 *
 * The server routes an RPC by its method name, which travels in clear next to
 * the sealed params. Without a binding it can send a request it relayed once
 * again, or send its ciphertext to another method: a `readFile {path}` turned
 * into `deleteFile {path}`, or a stored metadata blob handed to a handler that
 * ignores its params. A bound request names its method and scope, when it was
 * issued and a nonce inside the ciphertext. The daemon runs it only for that
 * method and scope, within the window, once. The reply carries the nonce back,
 * so a client takes no reply recorded for another request.
 *
 * Plaintext of a bound request: `{ rpcBinding: 1, method, scope, issuedAt, nonce, params }`.
 * Plaintext of its reply: `{ rpcBinding: 1, nonce, result }`.
 */
export const RPC_BINDING_VERSION = 1;

/** How far a request's issue time may be from the receiver's clock, either way. */
export const RPC_BINDING_WINDOW_MS = 5 * 60_000;

const nonceSchema = z.string().regex(/^[A-Za-z0-9+/]{22}==$/);
const nameSchema = z.string().min(1).max(256);

const boundRequestSchema = z.object({
  rpcBinding: z.literal(RPC_BINDING_VERSION),
  method: nameSchema,
  scope: nameSchema,
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nonce: nonceSchema,
  params: z.unknown().optional(),
}).strict();

const boundResponseSchema = z.object({
  rpcBinding: z.literal(RPC_BINDING_VERSION),
  nonce: nonceSchema,
  result: z.unknown().optional(),
}).strict();

export type BoundRpcRequest = z.infer<typeof boundRequestSchema>;
export type BoundRpcResponse = z.infer<typeof boundResponseSchema>;

export type RpcBindingRefusalCode =
  | 'RPC_BINDING_MALFORMED'
  | 'RPC_METHOD_MISMATCH'
  | 'RPC_SCOPE_MISMATCH'
  | 'RPC_REQUEST_STALE';

/** A daemon or session that reads bound requests says so in metadata only the scope key opens. */
export const rpcBindingCapabilitySchema = z.object({ version: z.literal(RPC_BINDING_VERSION) });
export type RpcBindingCapability = z.infer<typeof rpcBindingCapabilitySchema>;

/** `method` is the bare method, without the scope prefix the server routes on. */
export function bindRpcRequest(input: {
  method: string;
  scope: string;
  params: unknown;
  issuedAt: number;
  /** 16 random bytes, base64. */
  nonce: string;
}): BoundRpcRequest {
  return {
    rpcBinding: RPC_BINDING_VERSION,
    method: input.method,
    scope: input.scope,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    params: input.params,
  };
}

/**
 * How the receiver reads opened params. `unbound` is a request in the format
 * before binding; whether to run it is the caller's policy. A refusal keeps
 * the nonce when it has one, so the reply can still be bound to it.
 */
export function readBoundRpcRequest(
  value: unknown,
  expected: { method: string; scope: string; now: number },
):
  | { kind: 'unbound' }
  | { kind: 'bound'; params: unknown; nonce: string; issuedAt: number }
  | { kind: 'refused'; code: RpcBindingRefusalCode; nonce?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('rpcBinding' in value)) {
    return { kind: 'unbound' };
  }
  const parsed = boundRequestSchema.safeParse(value);
  if (!parsed.success) {
    const nonce = nonceSchema.safeParse((value as { nonce?: unknown }).nonce);
    return { kind: 'refused', code: 'RPC_BINDING_MALFORMED', ...(nonce.success ? { nonce: nonce.data } : {}) };
  }
  const request = parsed.data;
  if (request.method !== expected.method) return { kind: 'refused', code: 'RPC_METHOD_MISMATCH', nonce: request.nonce };
  if (request.scope !== expected.scope) return { kind: 'refused', code: 'RPC_SCOPE_MISMATCH', nonce: request.nonce };
  if (Math.abs(expected.now - request.issuedAt) > RPC_BINDING_WINDOW_MS) {
    return { kind: 'refused', code: 'RPC_REQUEST_STALE', nonce: request.nonce };
  }
  return { kind: 'bound', params: request.params ?? null, nonce: request.nonce, issuedAt: request.issuedAt };
}

export function bindRpcResponse(nonce: string, result: unknown): BoundRpcResponse {
  return { rpcBinding: RPC_BINDING_VERSION, nonce, result };
}

/** The result of the reply to the request with this nonce; anything else is refused. */
export function readBoundRpcResponse(
  value: unknown,
  nonce: string,
): { ok: true; result: unknown } | { ok: false; code: 'RPC_RESPONSE_UNBOUND' | 'RPC_RESPONSE_MISMATCH' } {
  const parsed = boundResponseSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: 'RPC_RESPONSE_UNBOUND' };
  if (parsed.data.nonce !== nonce) return { ok: false, code: 'RPC_RESPONSE_MISMATCH' };
  return { ok: true, result: parsed.data.result ?? null };
}
