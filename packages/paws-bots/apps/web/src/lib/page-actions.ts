import type { PageDetail, PageSummary } from "@rakazo/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { SpaceQueries } from "./query";
import { errorCode } from "./user-error";

/**
 * What the page's rename, sharing, pin and delete write back to the cache once the server
 * answers. Each write is keyed by the page the request named, never by whichever page is open
 * when the answer lands. A failure may still have been saved with only its answer lost, so the
 * page and the lists are read again rather than trusted as they were.
 */
export function pageMutationOptions(queries: SpaceQueries, queryClient: QueryClient) {
  // Every read of the page, the share popover's with its link included.
  const patch = (pageId: string, change: Partial<PageDetail>) =>
    queryClient.setQueriesData<PageDetail>(
      { queryKey: queries.pages.get.queryKey({ input: { pageId } }) },
      (current) => (current ? { ...current, ...change } : current),
    );
  const relist = () => queryClient.invalidateQueries({ queryKey: queries.pages.list.key() });
  const reconcile = (_error: unknown, input: { pageId: string }) => {
    void queryClient.invalidateQueries({
      queryKey: queries.pages.get.queryKey({ input: { pageId: input.pageId } }),
    });
    void relist();
  };
  return {
    rename: {
      mutationFn: (input: Parameters<typeof queries.pages.rename.call>[0]) =>
        queries.pages.rename.call(input),
      onSuccess: (summary: PageSummary, input: { pageId: string }) => {
        patch(input.pageId, { title: summary.title });
        // The share link's slug comes from the title, so read the page again for the new link.
        reconcile(null, input);
      },
      onError: reconcile,
    },
    setVisibility: {
      mutationFn: (input: Parameters<typeof queries.pages.setVisibility.call>[0]) =>
        queries.pages.setVisibility.call(input),
      onSuccess: (
        result: Pick<PageDetail, "visibility" | "shareUrl">,
        input: { pageId: string },
      ) => {
        patch(input.pageId, result);
        void relist();
      },
      onError: reconcile,
    },
    pin: {
      mutationFn: (input: Parameters<typeof queries.pages.pin.call>[0]) =>
        queries.pages.pin.call(input),
      onSuccess: (summary: PageSummary, input: { pageId: string }) => {
        patch(input.pageId, { pinned: summary.pinned });
        void relist();
      },
      onError: reconcile,
    },
    remove: {
      // NOT_FOUND: another tab deleted it first, which is the outcome asked for.
      mutationFn: (input: Parameters<typeof queries.pages.remove.call>[0]) =>
        queries.pages.remove.call(input).catch((error: unknown) => {
          if (errorCode(error) === "NOT_FOUND") return { ok: true as const };
          throw error;
        }),
      onSuccess: (_result: unknown, input: { pageId: string }) => {
        // A reset, unlike a removal, asks again for the page cards still on screen.
        void queryClient.resetQueries({
          queryKey: queries.pages.get.queryKey({ input: { pageId: input.pageId } }),
        });
        void relist();
      },
      onError: reconcile,
    },
  };
}

/** A new page card relists every cached page list, the Library's pages and the palette's alike. */
export function relistPagesForBlocks(
  queries: SpaceQueries,
  queryClient: QueryClient,
  blocks: readonly { kind?: string }[],
) {
  if (!blocks.some((block) => block.kind === "page")) return;
  void queryClient.invalidateQueries({ queryKey: queries.pages.list.key() });
}
