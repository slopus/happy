import { createHash } from "node:crypto";

export type InboundSource = "webhook" | "github" | "messaging" | "email";

/** Idempotency key of a messaging wake: one per provider message. */
export function messagingWakeIdempotencyKey(provider: string, handle: string): string {
  return `${provider}:${handle}`;
}

export function inboundDeliveryClientNonce(
  source: InboundSource,
  botId: string,
  idempotencyKey: string,
): string {
  return `${source}:${botId}:${createHash("sha256").update(idempotencyKey).digest("base64url")}`;
}
