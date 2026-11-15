import { newClientId } from "./client-id.js";

/**
 * clientNonce prefix for messages a client sends from a live voice call. The
 * nonce is the only channel that carries the call's identity: the server reads
 * it to answer in spoken sentences, and clients group one call's exchange into
 * a single transcript card.
 */
export const CALL_CLIENT_NONCE_PREFIX = "call:";

export function callClientNonce(callId: string): string {
  if (callId.includes(":")) throw new Error(`callId must not contain ":": ${callId}`);
  return `${CALL_CLIENT_NONCE_PREFIX}${callId}:${newClientId()}`;
}

export function isCallClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith(CALL_CLIENT_NONCE_PREFIX));
}

export function callIdFromClientNonce(clientNonce: string | null | undefined): string | undefined {
  if (!clientNonce || !isCallClientNonce(clientNonce)) return undefined;
  const rest = clientNonce.slice(CALL_CLIENT_NONCE_PREFIX.length);
  const suffixAt = rest.lastIndexOf(":");
  return suffixAt === -1 ? undefined : rest.slice(0, suffixAt) || undefined;
}
