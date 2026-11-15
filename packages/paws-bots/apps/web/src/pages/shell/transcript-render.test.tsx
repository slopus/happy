// @vitest-environment jsdom
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useCallback, useMemo, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { Transcript } from "./transcript";

const messageRenders = vi.hoisted(() => new Map<string, number>());

vi.mock("./message-view", async () => {
  const { createElement, memo } = await import("react");
  return {
    MessageView: memo(function MessageView({
      message,
      separateAnswers,
    }: {
      message: { id: string };
      separateAnswers?: ReadonlySet<MessageBlock>;
    }) {
      messageRenders.set(message.id, (messageRenders.get(message.id) ?? 0) + 1);
      return createElement("div", {
        "data-testid": `message-${message.id}`,
        "data-separate-answer": separateAnswers ? "linked" : undefined,
      });
    }),
  };
});

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  messageRenders.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollTo = () => undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function message(id: string, text: string): ThreadMessage {
  return {
    id,
    threadId: "thread",
    seq: 1,
    role: "bot",
    createdAt: "2026-10-30T12:00:00.000Z",
    blocks: [{ kind: "text", text }],
  };
}

function Host({ messages }: { messages: ThreadMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const artifactTarget = useMemo(() => ({ botId: "bot" }), []);
  const none = useMemo(() => new Set<string>(), []);
  const reply = useCallback(() => undefined, []);
  const resolved = useCallback(async () => undefined, []);
  const quote = useCallback(() => undefined, []);
  const peer = useCallback(() => undefined, []);
  const refresh = useCallback(async () => undefined, []);
  const answer = useCallback(async () => undefined, []);
  const react = useCallback(async () => undefined, []);
  return (
    <Transcript
      rpc={rpc}
      scrollRef={scrollRef}
      scrollRequest={null}
      onScrollRequestHandled={reply}
      followRequest={0}
      artifactTarget={artifactTarget}
      transcript={{
        messages,
        folded: new Map(),
        markerOf: new Map(),
        mergedInto: new Map(),
      }}
      showToolActivity={false}
      olderCursor={null}
      unreadAfterSeq={null}
      loadingOlder={false}
      answerableAskIds={none}
      dismissableAskIds={none}
      running={false}
      workingBots={[]}
      onLoadOlder={reply}
      onOpenBot={reply}
      onAnswer={answer}
      onReply={reply}
      onMarkUnread={reply}
      onQuote={quote}
      onReact={react}
      onJumpToMessage={reply}
      onOpenPeerMessages={peer}
      peerBot={peer}
      onRefresh={refresh}
      onBotChanged={refresh}
      onAddRoutine={quote}
      voiceReady={false}
      speakingMessageId={null}
      callHoldsSpeaker={false}
      onSpeak={reply}
      onOpenComputer={reply}
      onReleaseComputer={resolved}
    />
  );
}

it.each([false, true])(
  "leaves an unchanged message unrendered when a later one updates (mentions: %s)",
  (withMentions) => {
    const kept = message("kept", "Earlier");
    const announcement: ThreadMessage = {
      ...message("announcement", ""),
      blocks: [{ kind: "child_bot", botId: "child", name: "Planner", status: "created" }],
    };
    const earlier = withMentions ? [announcement, kept] : [kept];
    const live = message("progress:run", "Draft");
    act(() => root.render(<Host messages={[...earlier, live]} />));
    expect(messageRenders.get("kept")).toBe(1);
    expect(messageRenders.get("progress:run")).toBe(1);

    act(() =>
      root.render(<Host messages={[...earlier, message("progress:run", "Draft continues")]} />),
    );
    expect(messageRenders.get("kept")).toBe(1);
    expect(messageRenders.get("progress:run")).toBe(2);
    if (withMentions) {
      expect(messageRenders.has("announcement")).toBe(false);
      const renamed: ThreadMessage = {
        ...announcement,
        blocks: [{ kind: "child_bot", botId: "child", name: "Writer", status: "created" }],
      };
      act(() => root.render(<Host messages={[renamed, kept, live]} />));
      expect(messageRenders.get("kept")).toBe(2);
    }
  },
);

it("redraws a page card's reply only when a newer card supersedes it", () => {
  const card = (id: string, version: number): ThreadMessage => ({
    ...message(id, ""),
    botId: "bot",
    blocks: [{ kind: "page", pageId: "page", version, title: "Plan" }],
  });
  const reply = { ...message("reply", "Here is the plan"), botId: "bot" };
  const earlier = [card("card", 1), reply];
  act(() => root.render(<Host messages={[...earlier, message("progress:run", "Draft")]} />));
  act(() =>
    root.render(<Host messages={[...earlier, message("progress:run", "Draft continues")]} />),
  );
  expect(messageRenders.has("card")).toBe(false);
  expect(messageRenders.get("reply")).toBe(1);

  act(() => root.render(<Host messages={[...earlier, card("card-2", 2)]} />));
  expect(messageRenders.get("reply")).toBe(2);
});

it.each(["Build a plan", "👍"])(
  "only marks a question's answer as repeated while its user message is visible (%s)",
  (answer) => {
    const question: ThreadMessage = {
      ...message("question", ""),
      blocks: [
        {
          kind: "ask",
          text: "What next?",
          status: "answered",
          answer,
          answerMessageId: "reply",
        },
      ],
    };
    const reply: ThreadMessage = {
      ...message("reply", answer),
      replyToMessageId: question.id,
      role: "user",
      seq: 2,
    };
    act(() => root.render(<Host messages={[question]} />));
    expect(
      container
        .querySelector('[data-testid="message-question"]')
        ?.getAttribute("data-separate-answer"),
    ).toBeNull();
    act(() => root.render(<Host messages={[question, reply]} />));
    expect(
      container
        .querySelector('[data-testid="message-question"]')
        ?.getAttribute("data-separate-answer"),
    ).toBe("linked");
    act(() => root.render(<Host messages={[question]} />));
    expect(
      container
        .querySelector('[data-testid="message-question"]')
        ?.getAttribute("data-separate-answer"),
    ).toBeNull();
  },
);
