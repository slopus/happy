// @vitest-environment jsdom

import type { Bot, Routine } from "@rakazo/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query";
import { useComposerMentions } from "./use-composer-mentions";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ i18n: { locale: "en" } }) }));
vi.mock("../../lib/cron", () => ({ cronLabels: () => undefined }));
vi.mock("../../lib/query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnMount: "always" } },
    }),
  };
});

const bots = Array.from({ length: 100 }, (_, index) => ({
  id: `bot-${index}`,
  name: `Bot ${index}`,
})) as Bot[];
const rows = (botId: string, name = botId) =>
  [{ id: `routine-${botId}`, botId, name, crons: [] }] as unknown as Routine[];
const key = (space: string, botId: string) => [space, "routines", botId];
function fixture(space: string) {
  const batch = vi.fn(async ({ botIds }: { botIds: string[] }) =>
    [...botIds].reverse().map((botId) => ({ botId, routines: rows(botId, space) })),
  );
  const single = vi.fn(async ({ botId }: { botId: string }) => rows(botId, space));
  const props = {
    rpc: {
      routines: { listForMentions: batch, list: single },
      connections: { catalog: async () => [], list: async () => [] },
    },
    queries: {
      routines: {
        list: {
          queryOptions: ({ input }: { input: { botId: string } }) => ({
            queryKey: key(space, input.botId),
            queryFn: () => single(input),
          }),
        },
      },
      connections: {
        catalog: { queryKey: () => [space, "connections"] },
        key: () => [space, "connections"],
      },
    },
    bots,
    groups: [],
    inGroup: false,
    groupId: undefined,
    integrationsOpen: false,
    initialBotsLoaded: true,
  } as unknown as Parameters<typeof useComposerMentions>[0];
  return { props, batch, single };
}
let latest: ReturnType<typeof useComposerMentions>;
function Probe({ props }: { props: Parameters<typeof useComposerMentions>[0] }) {
  latest = useComposerMentions(props);
  return null;
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

it("keeps per-bot cache data and one-bot invalidation while batching the cold roster", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = fixture("space-a");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.batch.mockImplementationOnce(async ({ botIds }) => {
    await pending;
    return [...botIds].reverse().map((botId) => ({ botId, routines: rows(botId, "space-a") }));
  });
  const root = createRoot(document.createElement("div"));
  const render = (props = f.props) =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, { props }),
        ),
      ),
    );
  queryClient.setQueryData(key("space-a", "bot-0"), rows("bot-0", "Cached"));
  await render();
  expect(latest.composerMentionTargets.filter((target) => target.kind === "routine")).toMatchObject(
    [{ name: "Cached" }],
  );
  release();
  await act(async () => {
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(key("space-a", "bot-99"))).toEqual(rows("bot-99", "space-a")),
    );
  });
  expect(f.batch).toHaveBeenCalledTimes(1);
  expect(f.single).not.toHaveBeenCalled();
  expect(latest.composerMentionTargets.filter((target) => target.kind === "routine")).toHaveLength(
    100,
  );
  // Renaming a roster row keeps its query and existing data.
  await render({
    ...f.props,
    bots: bots.map((bot, index) => (index === 0 ? { ...bot, name: "Renamed" } : bot)),
  });
  expect(f.batch).toHaveBeenCalledTimes(1);
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: key("space-a", "bot-0"), exact: true });
  });
  expect(f.single).toHaveBeenCalledExactlyOnceWith({ botId: "bot-0" }, expect.anything());
  expect(f.batch).toHaveBeenCalledTimes(1);
  const saved = queryClient.getQueryData(key("space-a", "bot-0"));
  f.single.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: key("space-a", "bot-0"), exact: true });
  });
  expect(queryClient.getQueryData(key("space-a", "bot-0"))).toEqual(saved);
  // A different scope has separate keys and a separately pinned client.
  const other = fixture("space-b");
  await render(other.props);
  await act(async () => {
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(key("space-b", "bot-99"))).toEqual(rows("bot-99", "space-b")),
    );
  });
  expect(queryClient.getQueryData(key("space-a", "bot-99"))).toEqual(rows("bot-99", "space-a"));
  expect(other.batch).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
