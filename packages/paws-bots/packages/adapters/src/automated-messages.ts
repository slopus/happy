/**
 * Messages that Rakazo, or its model library, adds to a conversation in the user's role
 * are not from the user: screenshots moved out of tool results, nudges to continue,
 * finished background shell output, a helper's task. Models (local ones especially)
 * took them for the user replying, kept going instead of asking, and confused their
 * helpers with the user. Label them plainly.
 */
export const AUTOMATED_MESSAGE_LABEL = "[Automated message from Rakazo, not from the user]";

export function automated(text: string): string {
  return `${AUTOMATED_MESSAGE_LABEL} ${text}`;
}

/** Follows a kept reply in later history, so the model knows that reply is incomplete. */
export const PARTIAL_REPLY_NOTE = automated(
  "This reply was cut off by an error before it was finished.",
);

/** What pi-ai writes before screenshots it moves out of a tool result into a user message. */
export const TOOL_IMAGES_TEXT = "Attached image(s) from tool result:";
export const TOOL_IMAGES_LABEL = automated(
  "Screenshot(s) returned by your last tool call. The user has not replied.",
);

type Part = { type?: unknown; text?: unknown };

/**
 * Relabel those screenshot messages in an OpenAI-style request payload. Returns a new
 * payload when something changed, otherwise undefined (pi-ai then keeps its own).
 */
export function relabelToolImageMessages(payload: unknown): unknown {
  const messages = (payload as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  let changed = false;
  const next = messages.map((message: { role?: unknown; content?: unknown }) => {
    if (message?.role !== "user" || !Array.isArray(message.content)) return message;
    const [first, ...rest] = message.content as Part[];
    if (first?.type !== "text" || first.text !== TOOL_IMAGES_TEXT) return message;
    changed = true;
    return { ...message, content: [{ ...first, text: TOOL_IMAGES_LABEL }, ...rest] };
  });
  return changed ? { ...(payload as object), messages: next } : undefined;
}

type PayloadHook = (payload: unknown, model: never) => unknown;

/** Stream options with the relabel step added after any onPayload hook already there. */
export function withAutomatedLabels<O extends object>(options: O | undefined): O {
  const previous = (options as { onPayload?: PayloadHook } | undefined)?.onPayload;
  return {
    ...(options ?? {}),
    onPayload: async (payload: unknown, model: never) => {
      const replaced = previous ? await previous(payload, model) : undefined;
      return relabelToolImageMessages(replaced ?? payload) ?? replaced;
    },
  } as O;
}
