// @vitest-environment jsdom

import type { SearchHit } from "@rakazo/contracts";
import { ContextMenuContent, ContextMenuItem } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { SpaceSearchResults } from "./SpaceSearch";
import type { ChatMenuTarget } from "./shell/chat-context-menu";
import { useSidebarSearch } from "./shell/use-sidebar-search";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function file(artifactId: string): SearchHit {
  return {
    kind: "file",
    botId: "bot-1",
    botName: "Scout",
    title: `${artifactId}.png`,
    snippet: "image/png, 10 bytes",
    messageId: "message-1",
    seq: 4,
    artifactId,
  };
}

it("renders every file sent in one message without duplicate-key errors", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () =>
    root.render(
      <SpaceSearchResults
        hits={[file("artifact-1"), file("artifact-2")]}
        loading={false}
        error={null}
        onRetry={() => {}}
        onSelect={() => {}}
      />,
    ),
  );
  expect(error).not.toHaveBeenCalled();
  expect(container.querySelectorAll("button")).toHaveLength(2);
  expect(container.querySelector("button")?.textContent).toContain("File");
});

it("opens the chat menu on bot and group results only, for chats in the roster", async () => {
  const hit = (fields: Partial<SearchHit>): SearchHit => ({
    kind: "conversation",
    title: "Chief",
    snippet: "",
    ...fields,
  });
  const hits = [
    hit({ botId: "bot-1", title: "Chief" }),
    hit({ groupId: "group-1", title: "Team" }),
    hit({ botId: "bot-2", title: "Archived" }),
    hit({ kind: "message", botId: "bot-1", title: "Message", messageId: "message-1" }),
  ];
  let open: ChatMenuTarget | null = null;
  function Harness({ loading = false }: { loading?: boolean }) {
    const [menu, setMenu] = useState<ChatMenuTarget | null>(null);
    open = menu;
    return (
      <SpaceSearchResults
        hits={hits}
        loading={loading}
        error={null}
        onRetry={() => {}}
        onSelect={() => {}}
        chatMenu={{
          menu,
          setMenu,
          content: (
            <ContextMenuContent>
              <ContextMenuItem>Pin {menu?.id}</ContextMenuItem>
            </ContextMenuContent>
          ),
          has: (chat) => chat.id !== "bot-2",
        }}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const rows = [...container.querySelectorAll("button")];
  expect(rows).toHaveLength(4);
  const rightClick = async (index: number) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => rows[index]!.dispatchEvent(event));
    return event.defaultPrevented;
  };

  expect(await rightClick(0)).toBe(true);
  expect(open).toEqual({ kind: "bot", id: "bot-1" });
  expect(document.querySelector('[role="menuitem"]')?.textContent).toBe("Pin bot-1");

  expect(await rightClick(1)).toBe(true);
  expect(open).toEqual({ kind: "group", id: "group-1" });
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(open).toBeNull();

  // A chat missing from the roster and a message result keep the browser's own menu.
  for (const index of [2, 3]) {
    expect(await rightClick(index)).toBe(false);
    expect(open).toBeNull();
  }

  // A new search replacing the results releases the open menu instead of reopening it later.
  expect(await rightClick(0)).toBe(true);
  await act(async () => root.render(<Harness loading />));
  expect(open).toBeNull();
  await act(async () => root.render(<Harness />));
  expect(document.querySelector('[role="menuitem"]')).toBeNull();
});

it("says the search failed instead of no results, ignoring superseded and cleared requests", async () => {
  vi.useFakeTimers();
  const pending: { resolve: (hits: SearchHit[]) => void; reject: (error: unknown) => void }[] = [];
  const query = vi.fn(
    () =>
      new Promise<{ hits: SearchHit[] }>((resolve, reject) =>
        pending.push({ resolve: (hits) => resolve({ hits }), reject }),
      ),
  );
  let setQuery!: (query: string) => void;
  function Harness() {
    const search = useSidebarSearch({
      rpc: { search: { query } } as unknown as Parameters<typeof useSidebarSearch>[0]["rpc"],
      navigate: vi.fn(),
    });
    setQuery = search.setQuery;
    return (
      <SpaceSearchResults
        hits={search.searchHits}
        loading={search.searchLoading}
        error={search.searchError}
        onRetry={search.retrySearch}
        onSelect={() => {}}
      />
    );
  }
  async function search(text: string) {
    await act(async () => setQuery(text));
    await act(async () => vi.advanceTimersByTime(200));
  }
  await act(async () => root.render(<Harness />));

  await search("first");
  await act(async () => pending[0]!.reject(new Error("Search is unavailable right now")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Search is unavailable right now",
  );
  expect(container.textContent).not.toContain("No results");

  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toBe("Searching…");
  await act(async () => vi.advanceTimersByTime(200));
  expect(query).toHaveBeenLastCalledWith({ q: "first" });
  await act(async () => pending[1]!.resolve([]));
  expect(container.textContent).toBe("No results");

  await search("third");
  await search("fourth");
  await act(async () => pending[2]!.reject(new TypeError("Failed to fetch")));
  expect(container.textContent).toBe("Searching…");
  await act(async () => pending[3]!.resolve([file("artifact-1")]));
  expect(container.querySelectorAll("button")).toHaveLength(1);

  await search("fifth");
  await act(async () => pending[4]!.reject(new TypeError("Failed to fetch")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not reach the server");
  await act(async () => setQuery(""));
  await act(async () => setQuery("sixth"));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => vi.advanceTimersByTime(200));
  await act(async () => setQuery(""));
  await act(async () => pending[5]!.reject(new Error("Search is unavailable right now")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(query).toHaveBeenCalledTimes(6);
});
