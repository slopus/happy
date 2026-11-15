import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const OPEN = "<think>";
const CLOSE = "</think>";

type Split = {
  /** The thoughts read so far; undefined when the text does not open with a think block. */
  thinking?: string;
  closed: boolean;
  /** The answer after the block, or the whole text when there is none. */
  text: string;
  /** Too little text to tell yet whether it opens with a think block. */
  pending: boolean;
};

function splitLeadingThink(raw: string, final: boolean): Split {
  const start = raw.trimStart();
  if (!start.startsWith(OPEN)) {
    const pending = !final && OPEN.startsWith(start);
    return { closed: false, text: pending ? "" : raw, pending };
  }
  const body = start.slice(OPEN.length).trimStart();
  const end = body.indexOf(CLOSE);
  if (end !== -1) {
    return {
      thinking: body.slice(0, end),
      closed: true,
      text: stripAnswerSeparators(body.slice(end + CLOSE.length), final),
      pending: false,
    };
  }
  // Keep back a tail that may be the start of the closing tag, so thoughts only ever grow.
  let held = final ? 0 : Math.min(CLOSE.length - 1, body.length);
  while (held > 0 && !CLOSE.startsWith(body.slice(body.length - held))) held -= 1;
  return {
    thinking: body.slice(0, body.length - held),
    closed: false,
    text: "",
    pending: false,
  };
}

// Remove blank separator lines, retaining indentation on the first answer line.
function stripAnswerSeparators(raw: string, final: boolean): string {
  const text = raw.replace(/^(?:[ \t]*\r?\n)+/, "");
  return !final && /^[ \t]*\r?$/.test(text) ? "" : text;
}

type Rewritten = { message: AssistantMessage; index: number; split: Split };

/** The message with its first text block's leading think block as a thinking block, if it has one. */
function rewriteMessage(message: AssistantMessage, final: boolean): Rewritten | undefined {
  const index = message.content.findIndex((block) => block.type === "text");
  if (index === -1) return undefined;
  const block = message.content[index] as TextContent;
  const split = splitLeadingThink(block.text, final);
  if (split.thinking === undefined && !split.pending) return undefined;
  const thinking: ThinkingContent[] =
    split.thinking === undefined ? [] : [{ type: "thinking", thinking: split.thinking }];
  const text: TextContent[] =
    split.text || split.thinking === undefined ? [{ ...block, text: split.text }] : [];
  return {
    message: {
      ...message,
      content: [
        ...message.content.slice(0, index),
        ...thinking,
        ...text,
        ...message.content.slice(index + 1),
      ],
    },
    index,
    split,
  };
}

/**
 * Some local and compatible servers put a reasoning model's thoughts at the start of the answer
 * text as `<think>…</think>` instead of in a reasoning field. This reports that leading block as
 * thinking, the way a reasoning field is reported, so the thoughts are not shown as the answer
 * and are not sent back to the model on later steps. Text that opens any other way is untouched.
 */
export function splitLeadingThinkBlock(
  stream: AssistantMessageEventStream,
): AssistantMessageEventStream {
  class SplitStream extends AssistantMessageEventStream {
    override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      let plain = false;
      let textEnded = false;
      let heldTextStart = false;
      let receivedText = "";
      let firstTextIndex: number | undefined;
      let answerInserted = false;
      let thinkingStarted = false;
      let thinkingEnded = false;
      let thinkingSent = 0;
      let textStarted = false;
      let textSent = 0;
      for await (const event of stream) {
        if (plain) {
          yield event;
          continue;
        }
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          const final = rewriteMessage(message, true);
          const rewritten = final?.message;
          const thinking = final?.split.thinking;
          if (final && thinking !== undefined && thinkingStarted && !thinkingEnded) {
            const { index } = final;
            const partial = final.message;
            if (thinking.length > thinkingSent) {
              yield {
                type: "thinking_delta",
                contentIndex: index,
                delta: thinking.slice(thinkingSent),
                partial,
              };
            }
            yield { type: "thinking_end", contentIndex: index, content: thinking, partial };
            thinkingEnded = true;
          }
          if (!rewritten) yield event;
          else if (event.type === "done") yield { ...event, message: rewritten };
          else yield { ...event, error: rewritten };
          continue;
        }
        if (event.type === "start") {
          yield { ...event, partial: { ...event.partial, content: [] } };
          continue;
        }
        if (firstTextIndex === undefined && event.type === "text_start") {
          firstTextIndex = event.contentIndex;
        }
        const ownIndex = firstTextIndex ?? -1;
        const own = ownIndex !== -1 && "contentIndex" in event && event.contentIndex === ownIndex;
        if (own && event.type === "text_delta") receivedText += event.delta;
        if (own && event.type === "text_end") textEnded = true;
        // Upstream partials may be snapshots or one live object already ahead of this event.
        const observed =
          ownIndex === -1
            ? event.partial
            : {
                ...event.partial,
                content: event.partial.content.map((block, index) =>
                  index === ownIndex && block.type === "text"
                    ? { ...block, text: receivedText }
                    : block,
                ),
              };
        const rewritten =
          ownIndex !== -1 && event.partial.content[ownIndex]?.type === "text"
            ? rewriteMessage(observed, textEnded)
            : undefined;
        if (!rewritten) {
          if (ownIndex === -1 || event.partial.content[ownIndex]?.type !== "text") {
            if ("contentIndex" in event && answerInserted && firstTextIndex !== undefined) {
              yield {
                ...event,
                contentIndex: event.contentIndex + (event.contentIndex > firstTextIndex ? 1 : 0),
              };
            } else yield event;
            continue;
          }
          // The first text block opens some other way: release what was held and stand aside.
          plain = true;
          if (heldTextStart) {
            yield { type: "text_start", contentIndex: ownIndex, partial: observed };
            const held =
              event.type === "text_delta"
                ? receivedText.slice(0, receivedText.length - event.delta.length)
                : receivedText;
            if (held) {
              yield { type: "text_delta", contentIndex: ownIndex, delta: held, partial: observed };
            }
          }
          yield event;
          continue;
        }
        const { message: partial, index, split } = rewritten;
        if (split.thinking !== undefined && split.text) answerInserted = true;
        if (split.thinking !== undefined) {
          if (!thinkingStarted) {
            thinkingStarted = true;
            yield { type: "thinking_start", contentIndex: index, partial };
          }
          if (split.thinking.length > thinkingSent) {
            const delta = split.thinking.slice(thinkingSent);
            thinkingSent = split.thinking.length;
            yield { type: "thinking_delta", contentIndex: index, delta, partial };
          }
          if ((split.closed || textEnded) && !thinkingEnded) {
            thinkingEnded = true;
            yield { type: "thinking_end", contentIndex: index, content: split.thinking, partial };
          }
          if (split.text.length > textSent) {
            if (!textStarted) {
              textStarted = true;
              yield { type: "text_start", contentIndex: index + 1, partial };
            }
            const delta = split.text.slice(textSent);
            textSent = split.text.length;
            yield { type: "text_delta", contentIndex: index + 1, delta, partial };
          }
        }
        if (own) {
          if (event.type === "text_start") heldTextStart = true;
          else if (event.type === "text_end" && textStarted) {
            yield { type: "text_end", contentIndex: index + 1, content: split.text, partial };
          }
          continue;
        }
        const shift = answerInserted && event.contentIndex > index;
        yield { ...event, contentIndex: event.contentIndex + (shift ? 1 : 0), partial };
      }
    }
    override result(): Promise<AssistantMessage> {
      return stream.result().then((message) => rewriteMessage(message, true)?.message ?? message);
    }
  }
  return new SplitStream();
}
