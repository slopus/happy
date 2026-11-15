// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { ProductEvent, RoutineHistory, RoutineRun, ThreadSnapshot } from "@rakazo/contracts";
import { runThreadSubscription } from "@rakazo/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const routines = vi.hoisted(() => ({ history: vi.fn() }));
const threads = vi.hoisted(() => ({ get: () => new Promise(() => {}) }));
vi.mock("../lib/rpc", () => ({
  rpc: { routines, threads },
  rpcForSpace: () => ({ routines, threads }),
  createSpaceRpc: () => ({ routines, threads }),
  selectedSpaceId: () => null,
}));
vi.mock("@rakazo/core", async (original) => ({
  ...(await original<typeof import("@rakazo/core")>()),
  runThreadSubscription: vi.fn(async () => {}),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: parts }, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => (
    <button type="button" {...props} />
  ),
  SectionHeading: (props: ComponentProps<"h3">) => <h3 {...props} />,
  Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
}));

import { queryClient, useSpaceQueries } from "../lib/query";
import { RoutineRunHistory } from "./RoutineRunHistory";
import { useThreadSync } from "./shell/use-thread-sync";

const run: RoutineRun = {
  id: "run-1",
  botId: "bot-1",
  groupId: null,
  status: "completed",
  error: null,
  createdAt: "2026-01-02T12:00:00Z",
  startedAt: "2026-01-02T12:00:00Z",
  lateSince: null,
  completedAt: "2026-01-02T12:01:22Z",
  messageId: "reply-1",
};
const page = (runs: RoutineRun[], nextCursor: RoutineHistory["nextCursor"] = null) => ({
  runs,
  nextCursor,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  routines.history.mockReset();
});

async function mounted({
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  beside = null as ReactNode,
} = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <RoutineRunHistory routineId="routine-1" />
          {beside}
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => vi.waitFor(() => expect(routines.history).toHaveBeenCalled()));
  return {
    /** Waits for the list to show what the last response held. */
    settled: (check: () => void) => act(async () => vi.waitFor(check)),
    container,
    rows: () => container.querySelectorAll('[data-testid="routine-run-row"]'),
    button: (name: string) =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === name),
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("shows loading, then the latest runs as rows that open their chat", async () => {
  let finish!: (value: RoutineHistory) => void;
  routines.history.mockReturnValue(
    new Promise<RoutineHistory>((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  try {
    expect(view.container.querySelector('[role="status"][aria-label="Loading…"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain("No runs yet");
    await act(async () => finish(page([run, { ...run, id: "silent", messageId: null }])));
    await view.settled(() => expect(view.rows()).toHaveLength(2));
    expect(routines.history.mock.calls[0]?.[0]).toEqual({ routineId: "routine-1", limit: 5 });
    expect(view.container.textContent).not.toContain("1m 22s");
    expect(view.container.textContent).not.toContain("Done");
    expect(view.container.textContent).not.toContain("View chat");
    const links = view.container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/app/bot-1?m=reply-1");
    expect(view.rows()[0]?.textContent).not.toContain("No reply");
    expect(view.rows()[1]?.textContent).toContain("No reply");
    expect(view.button("Load older runs")).toBeUndefined();
  } finally {
    await view.close();
  }
});

it("stays hidden until the first run and picks it up on the next poll", async () => {
  vi.useFakeTimers();
  routines.history
    .mockResolvedValueOnce(page([]))
    .mockResolvedValue(page([{ ...run, messageId: null }]));
  const view = await mounted();
  try {
    expect(view.container.querySelector('[data-testid="routine-run-history"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(view.rows()).toHaveLength(1);
    expect(view.container.querySelector("a")).toBeNull();
  } finally {
    await view.close();
  }
});

it("says when history could not load and recovers on the next poll", async () => {
  vi.useFakeTimers();
  routines.history.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(page([run]));
  const view = await mounted();
  try {
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load run history",
    );
    expect(view.container.textContent).not.toContain("No runs yet");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.rows()).toHaveLength(1);
  } finally {
    await view.close();
  }
});

it("stops polling after a refused request", async () => {
  vi.useFakeTimers();
  routines.history.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
  const view = await mounted();
  try {
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(routines.history).toHaveBeenCalledTimes(1);
  } finally {
    await view.close();
  }
});

it("loads older runs below the latest ones until there are none left", async () => {
  const cursor = { id: "run-1", createdAt: run.createdAt };
  routines.history.mockImplementation(async (input: { before?: unknown }) =>
    input.before ? page([{ ...run, id: "older", messageId: null }]) : page([run], cursor),
  );
  const view = await mounted();
  try {
    await view.settled(() => expect(view.rows()).toHaveLength(1));
    await act(async () => view.button("Load older runs")?.click());
    await view.settled(() => expect(view.rows()).toHaveLength(2));
    expect(routines.history).toHaveBeenLastCalledWith(
      { routineId: "routine-1", before: cursor, limit: 20 },
      expect.anything(),
    );
    expect(view.button("Load older runs")).toBeUndefined();
  } finally {
    await view.close();
  }
});

it("says when older runs could not load and keeps what is shown", async () => {
  const cursor = { id: "run-1", createdAt: run.createdAt };
  routines.history.mockImplementation(async (input: { before?: unknown }) => {
    if (input.before) throw new Error("offline");
    return page([run], cursor);
  });
  const view = await mounted();
  try {
    await view.settled(() => expect(view.rows()).toHaveLength(1));
    await act(async () => view.button("Load older runs")?.click());
    await view.settled(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not load run history",
      ),
    );
    expect(view.rows()).toHaveLength(1);
    expect(view.button("Load older runs")).toBeDefined();
  } finally {
    await view.close();
  }
});
it("says when a scheduled run started late, and only then", async () => {
  routines.history.mockResolvedValue(
    page([
      { ...run, id: "minutes", lateSince: "2026-01-02T11:20:00Z" },
      { ...run, id: "hours", lateSince: "2026-01-02T09:30:00Z" },
      { ...run, id: "days", lateSince: "2025-12-30T12:00:00Z" },
      { ...run, id: "on-time" },
    ]),
  );
  const view = await mounted();
  try {
    await view.settled(() => expect(view.rows()).toHaveLength(4));
    expect([...view.rows()].map((row) => row.textContent?.match(/Started \S+ late/)?.[0])).toEqual([
      "Started 40m late",
      "Started 2h late",
      "Started 3d late",
      undefined,
    ]);
  } finally {
    await view.close();
  }
});

it("opens a group run in its group thread", async () => {
  routines.history.mockResolvedValue(page([{ ...run, groupId: "group-1" }]));
  const view = await mounted();
  try {
    await view.settled(() => expect(view.rows()).toHaveLength(1));
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "/app/g/group-1?m=reply-1",
    );
  } finally {
    await view.close();
  }
});

it("shows a silent failed run summary with diagnostics behind Details", async () => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const error = "504: request timed out";
  routines.history.mockResolvedValue(page([{ ...run, status: "failed", messageId: null, error }]));
  const view = await mounted();
  try {
    await view.settled(() => expect(view.rows()).toHaveLength(1));
    expect(view.container.textContent).toContain(
      "Your model provider took too long to respond. Try again.",
    );
    const details = view.container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Details");
    expect(details?.querySelector("pre")?.textContent).toBe(error);
    expect(view.container.querySelector("a")).toBeNull();
  } finally {
    await view.close();
  }
});

it("omits error UI for a completed run carrying a stale error", async () => {
  routines.history.mockResolvedValue(page([{ ...run, error: "504: request timed out" }]));
  const view = await mounted();
  try {
    await view.settled(() => expect(view.rows()).toHaveLength(1));
    expect(view.container.querySelector("details")).toBeNull();
    expect(view.container.textContent).not.toContain("Your model provider");
  } finally {
    await view.close();
  }
});

/** The open chat's live sync, with just enough wiring to deliver its events. */
function OpenChat() {
  const ref = <T,>(current: T) => ({ current });
  useThreadSync({
    rpc: { threads },
    queries: useSpaceQueries(),
    thread: {
      snapshotRef: ref(null),
      commitSnapshot: vi.fn(),
      bootstrappedThread: ref(null),
      expandedHistoryThread: ref(null),
      historyEpoch: ref(0),
      messageScroll: ref(null),
      pinnedAroundRef: ref(null),
    },
    computerState: { computerRef: ref(null), showCachedComputer: vi.fn() },
    active: { id: "bot-1", name: "Bot" },
    inGroup: false,
    activeBotId: ref("bot-1"),
    activeGroupId: ref(undefined),
    botsRef: ref([]),
    searchParamsRef: ref(new URLSearchParams()),
    refreshBots: async () => {},
    notifyBrowserForEvent: vi.fn(),
  } as unknown as Parameters<typeof useThreadSync>[0]);
  return null;
}

it("shows a run as finished as soon as the open chat reports it ended", async () => {
  vi.useFakeTimers();
  routines.history
    .mockResolvedValueOnce(page([{ ...run, status: "running", completedAt: null }]))
    .mockResolvedValue(page([run]));
  const view = await mounted({ client: queryClient, beside: <OpenChat /> });
  try {
    expect(view.container.textContent).toContain("Running");
    const subscription = vi.mocked(runThreadSubscription).mock.calls[0]![0];
    const ended = { type: "run.completed", runId: "run-1", payload: {} } as ProductEvent;
    await act(async () => {
      subscription.onEvent(ended, { threadId: "thread-1", cursor: 1 } as ThreadSnapshot);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(routines.history).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).not.toContain("Running");
    expect(view.rows()).toHaveLength(1);
  } finally {
    await view.close();
    queryClient.clear();
  }
});

it("leaves the history alone when a run it does not list ends", async () => {
  vi.useFakeTimers();
  routines.history
    .mockResolvedValueOnce(page([{ ...run, status: "running", completedAt: null }]))
    .mockResolvedValue(page([run]));
  const view = await mounted({ client: queryClient, beside: <OpenChat /> });
  try {
    expect(view.container.textContent).toContain("Running");
    const subscription = vi.mocked(runThreadSubscription).mock.calls[0]![0];
    const ended = { type: "run.completed", runId: "chat-run", payload: {} } as ProductEvent;
    await act(async () => {
      subscription.onEvent(ended, { threadId: "thread-1", cursor: 1 } as ThreadSnapshot);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(routines.history).toHaveBeenCalledTimes(1);
  } finally {
    await view.close();
    queryClient.clear();
  }
});
