import type { AdapterContext } from "./types.js";

export function createAdapterContext(
  actor: Pick<AdapterContext, "spaceId" | "userId">,
  botId: string,
  operationId: string,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}
