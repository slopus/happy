// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { foldPeerReplies } from "@rakazo/core";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { Transcript } from "./transcript";
import { resolveTranscriptMemberName } from "./transcript-member-name";

const stableT = (strings: TemplateStringsArray, ...values: unknown[]) =>
  String.raw(strings, ...values);

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: stableT }),
}));

vi.mock("../../lib/rpc", () => ({ rpc: {} }));

const G1 = "bot-g1";
const G2 = "bot-g2";
const ARCHIVED = "bot-archived";
const DELETED = "bot-deleted";

type Roster = {
  members: readonly { botId: string; name: string }[] | undefined;
  bots: readonly { id: string; name: string }[];
  archivedBots: readonly { id: string; name: string }[];
};

let container: HTMLDivElement;
let root: Root;
let scrollRef: RefObject<HTMLDivElement | null>;
let seq = 0;

beforeEach(() => {
  seq = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  scrollRef = { current: container };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function message(
  id: string,
  botId: string | undefined,
  blocks: ThreadMessage["blocks"],
  extra: Partial<ThreadMessage> = {},
): ThreadMessage {
  seq += 1;
  return {
    id,
    threadId: "thread",
    seq,
    role: "bot",
    ...(botId ? { botId } : {}),
    createdAt: "2026-11-11T12:00:00.000Z",
    blocks,
    ...extra,
  };
}

function renderTranscript(messages: ThreadMessage[], roster: Roster) {
  const memberName = (botId: string | undefined) =>
    resolveTranscriptMemberName({ botId, ...roster });
  const peerBot: ComponentProps<typeof Transcript>["peerBot"] = (botId) => {
    const bot = roster.bots.find((candidate) => candidate.id === botId);
    if (bot) return { name: bot.name, color: "blue" };
    const member = roster.members?.find((candidate) => candidate.botId === botId);
    return member ? { name: member.name, color: "blue" } : undefined;
  };
  const props: ComponentProps<typeof Transcript> = {
    scrollRef,
    scrollRequest: null,
    onScrollRequestHandled: vi.fn(),
    followRequest: 0,
    callHoldsSpeaker: false,
    artifactTarget: roster.members ? { groupId: "group" } : { botId: G1 },
    transcript: foldPeerReplies(messages, { includePeerReceipts: true }),
    showToolActivity: false,
    olderCursor: null,
    unreadAfterSeq: null,
    loadingOlder: false,
    answerableAskIds: new Set<string>(),
    dismissableAskIds: new Set<string>(),
    running: false,
    workingBots: [],
    onLoadOlder: vi.fn(),
    onOpenBot: vi.fn(),
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onMarkUnread: vi.fn(),
    onQuote: vi.fn(),
    onReact: vi.fn(),
    onJumpToMessage: vi.fn(),
    onOpenPeerMessages: vi.fn(),
    memberName,
    peerBot,
    onRefresh: vi.fn(),
    onBotChanged: vi.fn(),
    onAddRoutine: vi.fn(),
    voiceReady: false,
    speakingMessageId: null,
    onSpeak: vi.fn(),
    onOpenComputer: vi.fn(),
    onReleaseComputer: vi.fn(),
    rpc,
  };
  act(() => root.render(<Transcript {...props} />));
}

function header(messageId: string): string | null {
  const row = container.querySelector(`[data-message-id="${messageId}"]`);
  const name = row?.querySelector(".font-semibold.tracking-tight");
  const text = name?.textContent?.replace(/\s+/g, " ").trim();
  return text || null;
}

function handoffLine(messageId: string): string {
  const row = container.querySelector(`[data-message-id="${messageId}"]`);
  const line = [...(row?.querySelectorAll("span") ?? [])].find((span) =>
    span.textContent?.includes("↪"),
  );
  return line?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function replyLine(messageId: string): string {
  return (
    container
      .querySelector(`[data-message-id="${messageId}"] [data-testid="reply-parent-preview"]`)
      ?.textContent?.replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

it("group-removed-member-keeps-author-label", () => {
  renderTranscript(
    [
      message("g1", G1, [{ kind: "text", text: "Hello" }]),
      message("hand", G1, [{ kind: "handoff", fromBotId: G1, toBotId: G2, text: "Your turn" }]),
      message("g2", G2, [{ kind: "text", text: "Au" }]),
      message("gone", DELETED, [{ kind: "text", text: "Gone" }]),
      message("reply", G1, [{ kind: "text", text: "Seen" }], {
        replyToMessageId: "gone",
        replyPreview: { role: "bot", botId: DELETED, text: "Gone" },
      }),
      message("plain", undefined, [{ kind: "text", text: "Notice" }]),
    ],
    {
      members: [{ botId: G1, name: "G1" }],
      bots: [
        { id: G1, name: "G1" },
        { id: G2, name: "G2" },
      ],
      archivedBots: [],
    },
  );

  expect({
    g1: header("g1"),
    handoff: handoffLine("hand"),
    g2: header("g2"),
    gone: header("gone"),
    reply: replyLine("reply"),
    plain: header("plain"),
  }).toEqual({
    g1: "G1",
    handoff: "↪ G2 ← G1",
    g2: "G2",
    gone: "Deleted bot",
    reply: expect.stringContaining("Deleted bot: Gone"),
    plain: null,
  });
  expect(container.querySelector(`[data-message-id="plain"]`)?.textContent).not.toContain(
    "Deleted bot",
  );
});

it("group-removed-member-keeps-author-label for an archived bot", () => {
  renderTranscript(
    [
      message("old", ARCHIVED, [{ kind: "text", text: "Note" }]),
      message("reply", G1, [{ kind: "text", text: "Got it" }], {
        replyToMessageId: "old",
        replyPreview: { role: "bot", botId: ARCHIVED, text: "Note" },
      }),
    ],
    {
      members: [{ botId: G1, name: "G1" }],
      bots: [{ id: G1, name: "G1" }],
      archivedBots: [{ id: ARCHIVED, name: "G4" }],
    },
  );

  expect({ header: header("old"), reply: replyLine("reply") }).toEqual({
    header: "G4",
    reply: expect.stringContaining("G4: Note"),
  });
});

it("group-removed-member-keeps-author-label stays off a direct chat", () => {
  renderTranscript([message("direct", G1, [{ kind: "text", text: "Hello" }])], {
    members: undefined,
    bots: [{ id: G1, name: "Atlas" }],
    archivedBots: [{ id: G1, name: "Atlas" }],
  });

  expect(header("direct")).toBeNull();
  expect(container.querySelector(`[data-message-id="direct"]`)?.textContent).toContain("Hello");
  expect(container.querySelector(`[data-message-id="direct"]`)?.textContent).not.toContain("Atlas");
  expect(container.querySelector(`[data-message-id="direct"]`)?.textContent).not.toContain(
    "Deleted bot",
  );
});

it("group-removed-member-keeps-author-label prefers the current member", () => {
  renderTranscript([message("g1", G1, [{ kind: "text", text: "Hello" }])], {
    members: [{ botId: G1, name: "G1" }],
    bots: [{ id: G1, name: "Stale G1" }],
    archivedBots: [{ id: G1, name: "Older G1" }],
  });

  expect(header("g1")).toBe("G1");
  expect(container.querySelector(`[data-message-id="g1"]`)?.textContent).not.toContain("Stale");
  expect(container.querySelector(`[data-message-id="g1"]`)?.textContent).not.toContain("Older");
});
