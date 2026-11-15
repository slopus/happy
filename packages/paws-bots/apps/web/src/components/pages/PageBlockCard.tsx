import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { PageBlock } from "../../lib/page-cards";
import { useOpenPage, usePageDocument } from "../../lib/pages";
import { useSpaceQueries } from "../../lib/query";
import { errorCode } from "../../lib/user-error";
import { PageCard } from "./PageCard";

/**
 * A page saved in this chat. The newest card for a page draws its current version and title;
 * an older one keeps the version it was saved with and opens the latest.
 */
export function PageBlockCard({
  block,
  updated,
  onOpen,
}: {
  block: PageBlock;
  updated: boolean;
  onOpen?: () => void;
}) {
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const openPage = useOpenPage();
  const current = useQuery(queries.pages.get.queryOptions({ input: { pageId: block.pageId } }));
  const saved = useQuery({
    ...queries.pages.get.queryOptions({ input: { pageId: block.pageId, version: block.version } }),
    enabled: updated,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const currentVersion = current.data?.currentVersion;
  // A version saved after this page was read refreshes it, here and in the open page.
  useEffect(() => {
    if (!updated && currentVersion !== undefined && currentVersion < block.version) {
      void queryClient.invalidateQueries({
        queryKey: queries.pages.get.queryKey({ input: { pageId: block.pageId } }),
        exact: true,
      });
    }
  }, [updated, currentVersion, block.version, block.pageId, queries, queryClient]);
  const shown = updated ? saved.data : current.data;
  const viewer = usePageDocument(shown?.code);
  const deleted = errorCode(current.error) === "NOT_FOUND";
  const unread = shown === undefined && (updated ? saved.isError : current.isError);
  return (
    <PageCard
      title={current.data?.title ?? block.title}
      document={deleted ? null : viewer.document}
      failed={viewer.failed || unread}
      updated={updated}
      updatedAt={current.data?.updatedAt}
      shared={current.data?.visibility === "link"}
      onOpen={
        deleted
          ? undefined
          : () => {
              onOpen?.();
              openPage(block.pageId);
            }
      }
    />
  );
}
