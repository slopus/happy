import type { TranscriptContext } from "@earendil-works/pi-ai";

/**
 * Claude 5.5 binds each signed thinking block to the conversation prefix it was written in, and
 * Rakazo rewrites earlier history between requests, so a replayed block can make the provider
 * reject the whole request. Anthropic can drop such blocks itself (thinking.block_binding), but
 * proxies like OpenCode reject that field, so the runtime retries without the earlier thinking.
 * Encrypted reasoning only decrypts on the upstream that wrote it, so a router that sends the next
 * call elsewhere (OpenRouter's auto model, or another host of the same model) rejects it too.
 */
const MISMATCHED_SIGNATURE =
  /invalid `?signature`? in `?thinking`? block|bound to a different conversation|invalid_encrypted_content/i;

export function isThinkingSignatureMismatch(errorMessage: string | undefined): boolean {
  return !!errorMessage && MISMATCHED_SIGNATURE.test(errorMessage);
}

/** The context with signed thinking blocks removed from earlier assistant messages. */
export function withoutThinkingBlocks(context: TranscriptContext): TranscriptContext {
  const messages = withoutThinkingFrom(context.messages, 0);
  return messages === context.messages ? context : { ...context, messages };
}

/** OpenAI-compatible providers tag plain reasoning with the name of the field it came in. */
const REASONING_FIELD = /^reasoning(_content|_text)?$/;

/** Whether the provider can reject the block once the conversation before it changes. */
function isSignedThinking(part: { thinkingSignature?: string; redacted?: boolean }): boolean {
  return (
    !!part.redacted || (!!part.thinkingSignature && !REASONING_FIELD.test(part.thinkingSignature))
  );
}

/**
 * The messages with signed thinking blocks removed from assistant messages from `from` up to
 * `to`. Reasoning without a signature is not bound to the conversation and stays.
 */
export function withoutThinkingFrom<T extends TranscriptContext["messages"][number]>(
  messages: T[],
  from: number,
  to = messages.length,
): T[] {
  let changed = false;
  const result = messages.map((message, index) => {
    if (index < from || index >= to || message.role !== "assistant") return message;
    const content = message.content.filter(
      (part) => part.type !== "thinking" || !isSignedThinking(part),
    );
    if (content.length === message.content.length) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? result : messages;
}
