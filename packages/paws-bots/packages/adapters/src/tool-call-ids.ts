import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/**
 * A run's tool call ids. `provider` maps each repeated id renamed here back to the id the
 * provider sent, which stays the call's execution identity for effect idempotency and approvals,
 * as it was before the rename.
 */
export interface RunToolCallIds {
  used: Set<string>;
  provider: Map<string, string>;
}

/** The renamed call keeps the provider's id, so a restored transcript maps back to it. */
type RenamedToolCall = { providerCallId?: string };

/** Tool call ids already in a transcript, such as a restored checkpoint. */
export function runToolCallIds(
  messages: readonly Message[],
  provider = new Map<string, string>(),
): RunToolCallIds {
  const used = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      used.add(part.id);
      const original = (part as RenamedToolCall).providerCallId;
      if (original !== undefined) provider.set(part.id, original);
    }
  }
  return { used, provider };
}

/** The id the provider sent for a call, which may have been renamed in the transcript. */
export function providerToolCallId(
  provider: ReadonlyMap<string, string> | undefined,
  id: string,
): string {
  return provider?.get(id) ?? id;
}

/**
 * Some providers number tool calls per reply (call_0, call_1, ...) or leave the id out. Results,
 * context selection and the next request all pair a result with its call by id, so a repeated or
 * empty id attaches results to the wrong call. Renames such calls to an id unused in the run.
 */
export function withUniqueToolCallIds(
  message: AssistantMessage,
  ids: RunToolCallIds,
): AssistantMessage {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "toolCall") return part;
    if (part.id && !ids.used.has(part.id)) {
      ids.used.add(part.id);
      return part;
    }
    const base = part.id || "call";
    let suffix = 1;
    while (ids.used.has(`${base}_${suffix}`)) suffix++;
    const id = `${base}_${suffix}`;
    ids.used.add(id);
    changed = true;
    // A call that had no id is identified by its new one, which the transcript keeps across a resume.
    if (!part.id) return { ...part, id };
    ids.provider.set(id, part.id);
    return { ...part, id, providerCallId: part.id };
  });
  return changed ? { ...message, content } : message;
}

/** The model's stream with each completed reply's tool call ids made unique within the run. */
export function uniqueToolCallIdStream(
  source: AssistantMessageEventStream,
  ids: RunToolCallIds,
): AssistantMessageEventStream {
  const output = new AssistantMessageEventStream();
  void (async () => {
    let finished = false;
    for await (const event of source) {
      if (event.type === "done") {
        finished = true;
        output.push({ ...event, message: withUniqueToolCallIds(event.message, ids) });
      } else {
        if (event.type === "error") finished = true;
        output.push(event);
      }
    }
    output.end(finished ? undefined : withUniqueToolCallIds(await source.result(), ids));
  })();
  return output;
}
