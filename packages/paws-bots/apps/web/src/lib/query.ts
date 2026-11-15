import type { RouterUtils } from "@orpc/tanstack-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppBootstrap } from "@rakazo/contracts";
import { isRetryableError, retryDelayMs } from "@rakazo/core";
import type { DataTag, QueryKey } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { RpcClient } from "./rpc";
import { createSpaceRpc, rpcForSpace, selectedSpaceId } from "./rpc";
import { useBoundSpaceId } from "./space-rpc";

/**
 * Screens paint what they last saw and refresh it in the background, so moving between
 * spaces, chats, and settings sections does not wait on the network again.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      // Screens refresh every time they open, even over a recent read; live updates and
      // polling keep open ones current.
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      retry: (failures, error) => failures < 1 && isRetryableError(error),
      retryDelay: (_failures, error) => retryDelayMs(error, 1_000),
    },
  },
});

export type SpaceQueries = RouterUtils<RpcClient>;

const scopes = new Map<string, SpaceQueries>();

/**
 * Query helpers for one signed-in user in one space. Both are in every key, so cached data never
 * crosses an auth boundary, and each scope's client pins its own space header.
 */
export function spaceQueries(userId: string | null, spaceId: string | null): SpaceQueries {
  const path = [`user:${userId ?? ""}`, `space:${spaceId ?? ""}`];
  const id = path.join("\n");
  let scope = scopes.get(id);
  if (!scope) {
    scope = createTanstackQueryUtils(spaceId ? rpcForSpace(spaceId) : createSpaceRpc(null), {
      path,
    });
    scopes.set(id, scope);
  }
  return scope;
}

/**
 * Where a space's last bootstrap is kept. It holds the whole space (bots, groups, account), so
 * it is not keyed by bot: a visited space opens at once through any of its chats.
 */
export function spaceSeedKey(userId: string | null, spaceId: string | null) {
  return spaceQueries(userId, spaceId).bootstrap.queryKey({ input: {} });
}

export type ChatTarget =
  | { botId: string; groupId?: undefined }
  | { groupId: string; botId?: undefined };

/** Where a space keeps the chat it last had selected, apart from any snapshot that chat loaded. */
export function lastChatKey(userId: string | null, spaceId: string | null) {
  return [...spaceSeedKey(userId, spaceId), "last-chat"] as unknown as DataTag<
    QueryKey,
    ChatTarget
  >;
}

/** The chat a cached space had selected, if the space still lists it. */
export function lastChatOf(
  seed: AppBootstrap | undefined,
  chat: ChatTarget | undefined,
): ChatTarget | undefined {
  if (!seed || !chat) return undefined;
  if (chat.groupId) {
    return seed.groups.some((group) => group.id === chat.groupId) ? chat : undefined;
  }
  return seed.bots.some((bot) => bot.id === chat.botId) ? chat : undefined;
}

/**
 * What a space reopens with after the shell leaves it: its latest lists, and the loaded snapshot
 * only when it belongs to the selected chat. A chat picked just before leaving may still show the
 * previous chat's snapshot while its own loads.
 */
export function seedOnLeave(
  previous: AppBootstrap,
  latest: Omit<AppBootstrap, "thread" | "routines">,
  chat: ChatTarget | undefined,
  snapshot: AppBootstrap["thread"],
): AppBootstrap {
  const selected =
    snapshot &&
    chat &&
    (chat.groupId
      ? snapshot.groupId === chat.groupId
      : !snapshot.groupId && snapshot.botId === chat.botId);
  return { ...previous, ...latest, thread: selected ? snapshot : previous.thread };
}

const QueryUserContext = createContext<string | null>(null);

/** The signed-in user whose data the screens below may read from the cache. */
export const QueryUserProvider = QueryUserContext.Provider;

export function useQueryUserId(): string | null {
  return useContext(QueryUserContext);
}

/** Query helpers for the space these components act on: a bound settings space or the selected one. */
export function useSpaceQueries(): SpaceQueries {
  const userId = useQueryUserId();
  const boundSpaceId = useBoundSpaceId();
  const spaceId = boundSpaceId === undefined ? selectedSpaceId() : boundSpaceId;
  return spaceQueries(userId, spaceId);
}

let cachedUserId: string | null | undefined;

/** Forgets everything cached for another user, so sign-out or a switch never shows their data. */
export function setQueryUser(userId: string | null): void {
  if (cachedUserId !== undefined && cachedUserId !== userId) queryClient.clear();
  cachedUserId = userId;
}
