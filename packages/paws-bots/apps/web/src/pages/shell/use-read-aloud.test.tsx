// @vitest-environment jsdom

import type { Bot, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useReadAloud } from "./use-read-aloud";

const speakerMock = vi.hoisted(() => ({
  speak: vi.fn(async () => undefined),
  stop: vi.fn(),
  subscribe: (listener: (snapshot: { status: string }) => void) => {
    listener({ status: "idle" });
    return () => {};
  },
  isSpeaking: () => false,
}));
const speak = speakerMock.speak;

vi.mock("../../lib/tts", () => ({ speaker: speakerMock }));
vi.mock("@rakazo/ui-web", () => ({ toast: { error: vi.fn() } }));

const speaking: Bot = { id: "bot-b", autoSpeak: true } as unknown as Bot;

function message(id: string, text: string): ThreadMessage {
  return { id, role: "bot", blocks: [{ kind: "text", text }] } as unknown as ThreadMessage;
}

function snapshot(messages: ThreadMessage[]): ThreadSnapshot {
  return { botId: "bot-b", messages } as unknown as ThreadSnapshot;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useReadAloud>;

function renderRead(props: { snapshot: ThreadSnapshot; callBotId?: string }) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rerenderRead(props);
}

function rerenderRead({ snapshot, callBotId }: { snapshot: ThreadSnapshot; callBotId?: string }) {
  act(() => {
    root?.render(<ReadHarness active={speaking} snapshot={snapshot} callBotId={callBotId} />);
  });
}

function ReadHarness({
  active,
  snapshot,
  callBotId,
}: {
  active: Bot;
  snapshot: ThreadSnapshot;
  callBotId?: string;
}) {
  latest = useReadAloud({ active, snapshot, callBotId, activeBotId: { current: active.id } });
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

it("does not auto-speak a reply while a call with another bot is active", () => {
  const first = snapshot([message("m1", "first reply")]);
  renderRead({ snapshot: first });
  rerenderRead({
    snapshot: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
    callBotId: "bot-a",
  });
  expect(speak).not.toHaveBeenCalled();
  // The reply that arrived during the call stays marked spoken, not queued.
  rerenderRead({
    snapshot: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
  });
  expect(speak).not.toHaveBeenCalled();
});

it("auto-speaks a new reply when no call is active", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]) });
  rerenderRead({
    snapshot: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
  });
  expect(speak).toHaveBeenCalledWith("second reply", { botId: "bot-b", messageId: "m2" });
});

it("does not start a manual read while a call is active", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]), callBotId: "bot-a" });
  act(() => latest.speakMessage(message("m2", "spoken words")));
  expect(speak).not.toHaveBeenCalled();
});

it("reads a message on request when no call is active", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]) });
  act(() => latest.speakMessage(message("m2", "spoken words")));
  expect(speak).toHaveBeenCalledWith("spoken words", { botId: "bot-b", messageId: "m2" });
});
