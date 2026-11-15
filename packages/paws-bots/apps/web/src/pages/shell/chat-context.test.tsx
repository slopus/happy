// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { ComposerReplyPreview, ReplyLine, TimeSeparator, UnreadDivider } from "./chat-context";

vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: { get: vi.fn() } } }));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const message: ThreadMessage = {
  id: "reply",
  threadId: "thread",
  seq: 1,
  role: "user",
  createdAt: new Date().toISOString(),
  blocks: [],
  replyToMessageId: "parent",
  replyPreview: { role: "bot", botId: "bot", text: "First line\nSecond line" },
};
it("renders an unselectable semantic separator", () => {
  act(() =>
    root.render(
      <TimeSeparator createdAt={new Date(2026, 9, 6, 16, 5).toISOString()} locale="en-US" />,
    ),
  );
  expect(container.querySelector("h3")?.textContent).toContain("4:05 PM");
  expect(container.querySelector("h3")?.className).toContain("select-none");
});
it("marks new messages with a visible New and a spoken New messages", () => {
  act(() => root.render(<UnreadDivider />));
  const divider = container.querySelector('[data-testid="unread-divider"]');
  expect(divider?.querySelector('[aria-hidden="true"]:not(.h-px)')?.textContent).toBe("New");
  expect(divider?.querySelector(".sr-only")?.textContent).toBe("New messages");
  expect(divider?.className).toContain("select-none");
  const label = divider?.querySelector(".sr-only")?.parentElement;
  expect(label?.className).toContain("text-unread");
  expect(label?.className).not.toContain("opacity-50");
  for (const line of divider?.querySelectorAll(".h-px") ?? [])
    expect(line.className).toContain("bg-unread");
});
it("avoids extra top spacing after a time separator", () => {
  act(() => root.render(<UnreadDivider afterSeparator />));
  expect(container.querySelector('[data-testid="unread-divider"]')?.className).toContain("pt-0");
});
it("shows a compact composer quote and dismisses it", () => {
  const onDismiss = vi.fn();
  act(() =>
    root.render(
      <ComposerReplyPreview
        author="Helper"
        text={"First line\nSecond line"}
        onDismiss={onDismiss}
      />,
    ),
  );
  expect(container.textContent).toBe("Helper: First line");
  act(() => container.querySelector("button")!.click());
  expect(onDismiss).toHaveBeenCalledOnce();
});
it("navigates a one-line authoritative quote without a loaded parent", () => {
  const onJump = vi.fn();
  act(() => root.render(<ReplyLine message={message} author="Helper" onJump={onJump} />));
  expect(container.textContent).toBe("↩ Helper: First line");
  act(() => container.querySelector("button")!.click());
  expect(onJump).toHaveBeenCalledWith("parent");
});
it("renders a deleted target as static unavailable text", () => {
  act(() =>
    root.render(
      <ReplyLine
        message={{
          ...message,
          replyToMessageId: undefined,
          replyQuote: "Old text",
          replyPreview: null,
        }}
        author="Helper"
      />,
    ),
  );
  expect(container.textContent).toBe("Original message unavailable");
  expect(container.querySelector("button")).toBeNull();
});

it("dismisses a composer reply with Escape, but not the Escape that ends an IME composition", () => {
  const onDismiss = vi.fn();
  act(() =>
    root.render(<ComposerReplyPreview author="Helper" text="Quote" onDismiss={onDismiss} />),
  );
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, ...composition });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
  expect(onDismiss).not.toHaveBeenCalled();
  act(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
  );
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("keeps internal peer receipt replies out of the transcript", () => {
  act(() =>
    root.render(
      <ReplyLine
        message={{
          ...message,
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "peer",
              fromBotName: "Researcher",
              text: "peer response",
              hop: 1,
            },
          ],
          replyPreview: { role: "bot", botId: "bot", text: "peer-exchange-alpha" },
        }}
        author="Bot"
      />,
    ),
  );
  expect(container.textContent).toBe("");
});

const photo = { kind: "image" as const, artifactId: "photo", mimeType: "image/png", name: "" };
it.each([
  [photo, "", "Photo", true],
  [photo, "Caption", "Caption", true],
  [
    { ...photo, kind: "file" as const, name: "notes.txt", mimeType: "text/plain" },
    "",
    "notes.txt",
    false,
  ],
])(
  "renders attachment labels and authenticated thumbnails in both reply views",
  async (attachment, text, label, image) => {
    vi.mocked(rpc.artifacts.get).mockResolvedValue({
      contentBase64: "AA==",
      mimeType: "image/png",
    } as never);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:photo"), revokeObjectURL: vi.fn() });
    await act(async () =>
      root.render(
        <ComposerReplyPreview
          author="You"
          text={text}
          attachment={attachment}
          target={{ groupId: "group" }}
          onDismiss={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain(`You: ${label}`);
    expect(container.querySelector("img")?.getAttribute("src") ?? null).toBe(
      image ? "blob:photo" : null,
    );
    await act(async () =>
      root.render(
        <ReplyLine
          message={{ ...message, replyPreview: { role: "user", text, attachment } }}
          author="You"
          target={{ botId: "bot" }}
        />,
      ),
    );
    expect(container.textContent).toContain(`You: ${label}`);
    expect(container.querySelector("img")?.getAttribute("src") ?? null).toBe(
      image ? "blob:photo" : null,
    );
    if (image)
      expect(rpc.artifacts.get).toHaveBeenCalledWith({ botId: "bot", artifactId: "photo" });
  },
);
it("keeps image labels when fetching fails", async () => {
  vi.mocked(rpc.artifacts.get).mockRejectedValue(new Error("unavailable"));
  await act(async () =>
    root.render(
      <ReplyLine
        message={{ ...message, replyPreview: { role: "user", text: "", attachment: photo } }}
        author="You"
        target={{ botId: "bot" }}
      />,
    ),
  );
  expect(container.textContent).toContain("You: Photo");
  expect(container.querySelector("img")).toBeNull();
});

it("prefers a selected excerpt over the photo caption in the composer", () => {
  act(() =>
    root.render(
      <ComposerReplyPreview
        author="You"
        quote={"selected\ntext"}
        text="Caption"
        attachment={photo}
        onDismiss={vi.fn()}
      />,
    ),
  );
  expect(container.textContent).toBe("You: selected text");
});

it("defers transcript thumbnails until near the viewport while the composer loads immediately", async () => {
  vi.mocked(rpc.artifacts.get)
    .mockClear()
    .mockResolvedValue({
      contentBase64: "AA==",
      mimeType: "image/png",
    } as never);
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:photo"), revokeObjectURL: vi.fn() });
  let onIntersection!: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const observer = vi.fn(
    class {
      constructor(callback: IntersectionObserverCallback) {
        onIntersection = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.stubGlobal("IntersectionObserver", observer);
  await act(async () =>
    root.render(
      <ReplyLine
        message={{ ...message, replyPreview: { role: "user", text: "", attachment: photo } }}
        author="You"
        target={{ botId: "bot" }}
      />,
    ),
  );
  expect(rpc.artifacts.get).not.toHaveBeenCalled();
  expect(observer).toHaveBeenCalledWith(expect.any(Function), { rootMargin: "320px" });
  expect(observe).toHaveBeenCalledOnce();
  act(() =>
    onIntersection(
      [{ isIntersecting: false }] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    ),
  );
  expect(rpc.artifacts.get).not.toHaveBeenCalled();
  await act(async () =>
    onIntersection(
      [{ isIntersecting: true }] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledOnce();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:photo");
  expect(disconnect).toHaveBeenCalled();
  vi.mocked(rpc.artifacts.get).mockClear();
  observer.mockClear();
  await act(async () =>
    root.render(
      <ComposerReplyPreview
        author="You"
        text=""
        attachment={photo}
        target={{ groupId: "group" }}
        onDismiss={vi.fn()}
      />,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledOnce();
  expect(observer).not.toHaveBeenCalled();
});
it("shows no quote on a message sent from an open page, even with its card not loaded", () => {
  const card = { role: "bot" as const, botId: "bot", text: "Q3 plan", page: true as const };
  act(() => root.render(<ReplyLine message={{ ...message, replyPreview: card }} author="Bot" />));
  expect(container.textContent).toBe("");
  // A reply picked on the card in the chat keeps its quote.
  act(() =>
    root.render(
      <ReplyLine
        message={{ ...message, replyPreview: card, replyQuote: "Q3 plan" }}
        author="Bot"
      />,
    ),
  );
  expect(container.textContent).toContain("Q3 plan");
});
