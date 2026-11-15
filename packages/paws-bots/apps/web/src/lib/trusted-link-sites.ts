import { writeSaved } from "@rakazo/core/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { spaceQueries, useQueryUserId } from "./query";
import { rpc } from "./rpc";

const none: readonly string[] = [];

/**
 * The signed-in user's trusted link sites: links to them open without the external-link prompt.
 * They hold in every space, so one list per user serves the chat prompt and Settings alike.
 */
export function useTrustedLinkSites() {
  const userId = useQueryUserId();
  const queryClient = useQueryClient();
  const sites = useQuery({
    ...spaceQueries(userId, null).trustedLinkSites.list.queryOptions(),
    enabled: userId !== null,
  }).data;

  const save = useCallback(
    (update: (current: string[]) => string[]) =>
      writeSaved(
        queryClient,
        spaceQueries(userId, null).trustedLinkSites.list.queryKey(),
        (current) => update(current ?? []),
      ),
    [queryClient, userId],
  );
  const trust = useCallback(
    async (url: string) => {
      const queryKey = spaceQueries(userId, null).trustedLinkSites.list.queryKey();
      const { site } = await rpc.trustedLinkSites.trust({ url });
      const loaded = queryClient.getQueryData(queryKey) !== undefined;
      await save((current) => (current.includes(site) ? current : [...current, site].sort()));
      // Saved before the first read finished: the cache holds only this site until read again.
      if (!loaded) void queryClient.invalidateQueries({ queryKey, exact: true });
    },
    [queryClient, save, userId],
  );
  const remove = useCallback(
    async (site: string) => {
      await rpc.trustedLinkSites.remove({ site });
      await save((current) => current.filter((item) => item !== site));
    },
    [save],
  );
  return { sites: sites ?? none, trust: userId === null ? undefined : trust, remove };
}
