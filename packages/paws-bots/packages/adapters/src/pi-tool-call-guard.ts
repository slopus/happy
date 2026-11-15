import type { Message, MutableModels, Provider, TranscriptContext } from "@earendil-works/pi-ai";

/**
 * Some OpenAI-compatible gateways stream tool-call deltas whose `function.name`
 * never arrives. pi-ai keeps such a block with an empty name, and the gateway
 * then rejects the whole transcript on the next turn, so the call is dropped
 * together with its result.
 */
function hasToolCallName(name: string | undefined): boolean {
  return typeof name === "string" && name.trim().length > 0;
}

function hasNamelessToolCall(messages: readonly Message[]): boolean {
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content ?? []) {
        if (part.type === "toolCall" && !hasToolCallName(part.name)) return true;
      }
    } else if (message.role === "toolResult") {
      if (!hasToolCallName(message.toolName)) return true;
    }
  }
  return false;
}

export function withoutNamelessToolCalls(messages: readonly Message[]): Message[] {
  const droppedCallIds = new Set<string>();
  const callNames = new Map<string, string>();
  const kept: Message[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const originalContent = message.content ?? [];
      const content = originalContent.filter((part) => {
        if (part.type !== "toolCall") return true;
        if (hasToolCallName(part.name)) {
          callNames.set(part.id, part.name);
          return true;
        }
        droppedCallIds.add(part.id);
        return false;
      });
      if (content.length === originalContent.length) {
        kept.push(message.content == null ? { ...message, content } : message);
      } else if (content.length > 0) {
        kept.push({ ...message, content });
      }
      continue;
    }
    if (message.role === "toolResult") {
      if (droppedCallIds.has(message.toolCallId)) continue;
      if (!hasToolCallName(message.toolName)) {
        const toolName = callNames.get(message.toolCallId);
        if (toolName) kept.push({ ...message, toolName });
        continue;
      }
    }
    kept.push(message);
  }
  return kept;
}

function guardContext(context: TranscriptContext): TranscriptContext {
  if (!hasNamelessToolCall(context.messages)) return context;
  return { ...context, messages: withoutNamelessToolCalls(context.messages) };
}

const guardedProviders = new WeakSet<Provider>();

/** Sanitizes transcripts just before they are sent to the selected provider. */
export function guardToolCallNames(models: MutableModels, providerId: string): MutableModels {
  const provider = models.getProvider(providerId);
  if (!provider || guardedProviders.has(provider)) return models;
  const guarded = {
    ...provider,
    stream(model, context, options) {
      return provider.stream(model, guardContext(context), options);
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(model, guardContext(context), options);
    },
  } satisfies Provider;
  guardedProviders.add(guarded);
  models.setProvider(guarded);
  return models;
}
