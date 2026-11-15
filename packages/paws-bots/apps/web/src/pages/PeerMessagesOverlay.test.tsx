// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ messages: vi.fn() }));
vi.mock("../lib/rpc", () => {
  const client = { threads: api };
  return {
    rpc: client,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children, ...props }: { children?: ReactNode }) => (
    <div {...props}>{children}</div>
  );
  return {
    BotAvatar: () => null,
    Button: Container,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DialogTitle: Container,
    Spinner: () => null,
  };
});

vi.mock("./shell/message-cards", () => ({
  ArtifactImage: () => null,
  ChartBlockView: ({ name }: { name: string }) => <div data-testid="peer-chart">{name}</div>,
}));
vi.mock("../components/pages/PageBlockCard", () => ({
  PageBlockCard: ({
    block,
    updated,
    onOpen,
  }: {
    block: { title: string };
    updated: boolean;
    onOpen?: () => void;
  }) => (
    <button type="button" onClick={onOpen} data-testid="peer-page" data-updated={updated}>
      {block.title}
    </button>
  ),
}));

import { PeerMessagesOverlay } from "./PeerMessagesOverlay";

const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get");
const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get");

let root: Root | undefined;
let queryClient: QueryClient | undefined;

afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  document.body.innerHTML = "";
  api.messages.mockReset();
});

function exchange(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    blocks: [
      { kind: "bot_message_sent", toBotId: "peer", toBotName: "Researcher", text: `note ${index}` },
    ],
  }));
}

async function open(onClose = () => undefined) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient = client;
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <PeerMessagesOverlay
          botId="chief"
          botName="Chief"
          botColor="blue"
          peerBotId="peer"
          peerBotName="Researcher"
          peerBotColor="green"
          onClose={onClose}
        />
      </QueryClientProvider>,
    ),
  );
  await settle();
  const transcript = container.querySelector<HTMLElement>(
    '[data-testid="peer-conversation-transcript"]',
  );
  if (!transcript) throw new Error("transcript did not render");
  return { transcript, client };
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function scrollTo(transcript: HTMLElement, top: number) {
  transcript.scrollTop = top;
  await act(async () => transcript.dispatchEvent(new Event("scroll")));
}

async function refreshWithNewMessage(client: QueryClient) {
  scrollHeight.mockReturnValue(5_200);
  api.messages.mockResolvedValue({ messages: exchange(41), olderCursor: null });
  await act(async () => client.refetchQueries());
  await settle();
}

it("opens a long exchange at its latest message", async () => {
  scrollHeight.mockReturnValue(5_000);
  clientHeight.mockReturnValue(600);
  api.messages.mockResolvedValue({ messages: exchange(40), olderCursor: null });

  const { transcript } = await open();

  expect(transcript.textContent).toContain("note 39");
  expect(transcript.scrollTop).toBe(5_000);
});

it("follows a refresh only while the reader is at the latest message", async () => {
  scrollHeight.mockReturnValue(5_000);
  clientHeight.mockReturnValue(600);
  api.messages.mockResolvedValue({ messages: exchange(40), olderCursor: null });
  const atEnd = await open();
  await scrollTo(atEnd.transcript, 4_400);

  await refreshWithNewMessage(atEnd.client);

  expect(atEnd.transcript.textContent).toContain("note 40");
  expect(atEnd.transcript.scrollTop).toBe(5_200);

  act(() => root?.unmount());
  scrollHeight.mockReturnValue(5_000);
  api.messages.mockResolvedValue({ messages: exchange(40), olderCursor: null });
  const scrolledUp = await open();
  await scrollTo(scrolledUp.transcript, 1_000);

  await refreshWithNewMessage(scrolledUp.client);

  expect(scrolledUp.transcript.textContent).toContain("note 40");
  expect(scrolledUp.transcript.scrollTop).toBe(1_000);
});

it("shows chart-only and page-only replies and marks older page cards", async () => {
  api.messages.mockResolvedValue({
    messages: [
      {
        id: "wake",
        role: "bot",
        runId: "run",
        createdAt: "1",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "peer",
            fromBotName: "Peer",
            text: "Please report",
          },
        ],
      },
      {
        id: "chart",
        role: "bot",
        runId: "run",
        createdAt: "2",
        blocks: [{ kind: "chart", name: "Daily chart", spec: {}, data: [] }],
      },
      {
        id: "page1",
        role: "bot",
        runId: "run",
        createdAt: "3",
        blocks: [{ kind: "page", pageId: "page", title: "Old page", version: 1 }],
      },
      {
        id: "page2",
        role: "bot",
        runId: "run",
        createdAt: "4",
        blocks: [
          { kind: "text", text: "Latest report" },
          { kind: "page", pageId: "page", title: "New page", version: 2 },
        ],
      },
    ],
    olderCursor: null,
  });
  const close = vi.fn();
  const { transcript } = await open(close);
  act(() => transcript.querySelector<HTMLButtonElement>('[data-testid="peer-page"]')?.click());
  expect(close).toHaveBeenCalledOnce();
  expect(transcript.querySelector('[data-testid="peer-chart"]')?.textContent).toBe("Daily chart");
  expect(
    [...transcript.querySelectorAll('[data-testid="peer-page"]')].map((node) => [
      node.textContent,
      node.getAttribute("data-updated"),
    ]),
  ).toEqual([
    ["Old page", "true"],
    ["New page", "false"],
  ]);
  expect(transcript.textContent).toContain("Latest report");
});
