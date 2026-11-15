import { Trans, useLingui } from "@lingui/react/macro";
import { PageIcon } from "@rakazo/chat-ui/web";
import type { PageSummary } from "@rakazo/contracts";
import { PAGE_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import { uniquePages } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe, MoreHorizontal, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { pageMutationOptions } from "../../lib/page-actions";
import { useOpenPage } from "../../lib/pages";
import { useSpaceQueries } from "../../lib/query";
import { formatRelativeTime } from "../../lib/relative-time";
import { DeleteItemDialog } from "../../pages/shell/dialogs";

/** Enough to fill the panel; Show more brings the next batch. */
const PAGE_SIZE = 20;
/** A list this long gets a field to find a page by its title. */
const SEARCH_FROM = 8;

/**
 * The pages a bot or group built, pinned ones in their own group on top, then the newest. Each
 * bot or group gets its own list, so one's pages never stand in while another's load.
 */
export function PagesList({ botId, groupId }: { botId?: string; groupId?: string }) {
  return <OwnerPages key={botId ?? groupId} botId={botId} groupId={groupId} />;
}

function OwnerPages({ botId, groupId }: { botId?: string; groupId?: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const openPage = useOpenPage();
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const pages = useInfiniteQuery(
    queries.pages.list.infiniteOptions({
      input: (cursor: string | null) => ({
        ...(botId ? { botId } : { groupId }),
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        ...(query ? { query } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
      // A search keeps showing the last results until its own arrive.
      placeholderData: (previous) => previous,
    }),
  );
  const actions = pageMutationOptions(queries, queryClient);
  const pin = useMutation(actions.pin);
  const remove = useMutation(actions.remove);
  const rename = useMutation(actions.rename);
  const [deleting, setDeleting] = useState<PageSummary | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  if (pages.isPending) {
    return (
      <div className="grid place-items-center py-6 text-muted-foreground">
        <Spinner />
      </div>
    );
  }
  const items = uniquePages((pages.data?.pages ?? []).flatMap((read) => read.items));
  // A failed read is not an empty list: say so, and offer to read it again.
  if (pages.isError && items.length === 0) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 px-1 py-2">
        <p className="text-body-sm text-muted-foreground">
          <Trans>Couldn't load pages.</Trans>
        </p>
        <Button size="sm" variant="outline" onClick={() => void pages.refetch()}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  const searchable = query !== "" || items.length >= SEARCH_FROM || pages.hasNextPage;
  if (items.length === 0 && !searchable) {
    return (
      <p className="px-1 py-2 text-body-sm text-muted-foreground">
        {groupId ? (
          <Trans>
            Pages this group builds for you appear here. Ask for a dashboard, tracker or plan to
            make one.
          </Trans>
        ) : (
          <Trans>
            Pages this bot builds for you appear here. Ask for a dashboard, tracker or plan to make
            one.
          </Trans>
        )}
      </p>
    );
  }
  const commitRename = () => {
    if (!renaming) return;
    const next = renaming.draft.trim();
    const page = items.find((item) => item.id === renaming.id);
    setRenaming(null);
    if (page && next !== "" && next !== page.title) {
      pin.reset();
      rename.mutate({ pageId: page.id, title: next });
    }
  };
  const pinned = items.filter((page) => page.pinned);
  const rest = items.filter((page) => !page.pinned);
  const row = (page: PageSummary) => (
    <li key={page.id} className="flex items-center rounded-md hover:bg-accent">
      {renaming?.id === page.id ? (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-muted">
            <PageIcon className="h-5 w-4" />
          </span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because Rename was chosen.
            autoFocus
            aria-label={t`Page title`}
            value={renaming.draft}
            maxLength={PAGE_TITLE_MAX_LENGTH}
            onChange={(event) => setRenaming({ id: page.id, draft: event.target.value })}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                if (event.key === "Escape") event.stopPropagation();
                return;
              }
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                event.stopPropagation();
                setRenaming(null);
              }
            }}
            className="h-8 min-w-0 flex-1 rounded-sm bg-background px-2 text-body text-foreground ring-1 ring-ring outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => openPage(page.id)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-muted text-foreground">
            <PageIcon className="h-5 w-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body text-foreground" dir="auto">
              {page.title}
            </span>
            <span className="flex items-center gap-1 text-label text-muted-foreground">
              {page.visibility === "link" ? (
                <>
                  <Globe aria-hidden="true" className="size-3" strokeWidth={1.8} />
                  <Trans>Shared</Trans>
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              <span>{formatRelativeTime(page.updatedAt)}</span>
            </span>
          </span>
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Actions for ${page.title}`}
          className="me-1 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => openPage(page.id)}>
            <Trans>Open</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRenaming({ id: page.id, draft: page.title })}>
            <Trans>Rename</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openPage(page.id, { share: true })}>
            <Trans>Share</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pin.isPending}
            onClick={() => {
              rename.reset();
              pin.mutate({ pageId: page.id, pinned: !page.pinned });
            }}
          >
            {page.pinned ? <Trans>Unpin</Trans> : <Trans>Pin</Trans>}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(page)}>
            <Trans>Delete</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
  return (
    <div data-testid="bot-pages" className="flex flex-col gap-3">
      {searchable ? (
        <label className="flex h-9 items-center gap-2 rounded-md bg-muted px-2.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <input
            type="search"
            aria-label={t`Find a page`}
            placeholder={t`Find a page`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      ) : null}
      {rename.isError ? (
        <p role="alert" className="px-2 text-label text-destructive">
          <Trans>Could not rename this page. Try again.</Trans>
        </p>
      ) : pin.isError ? (
        <p role="alert" className="px-2 text-label text-destructive">
          <Trans>Could not pin this page. Try again.</Trans>
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="px-2 py-1 text-body-sm text-muted-foreground">
          <Trans>No pages match “{query}”.</Trans>
        </p>
      ) : null}
      {pinned.length ? (
        <section>
          <SectionHeading variant="label" className="mb-1 px-2">
            <Trans>Pinned</Trans>
          </SectionHeading>
          <ul className="flex flex-col">{pinned.map(row)}</ul>
        </section>
      ) : null}
      {rest.length ? <ul className="flex flex-col">{rest.map(row)}</ul> : null}
      {pages.isError ? (
        // A later read failed (Show more, or reading the list again): the pages above may be stale.
        <div role="alert" className="flex items-center gap-2 px-2 text-label text-destructive">
          <Trans>Couldn't load pages.</Trans>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void (pages.isFetchNextPageError ? pages.fetchNextPage() : pages.refetch())
            }
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {pages.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={pages.isFetchingNextPage}
          onClick={() => void pages.fetchNextPage()}
        >
          <Trans>Show more</Trans>
        </Button>
      ) : null}
      {deleting ? (
        <DeleteItemDialog
          item={{ name: deleting.title }}
          noun="page"
          description={
            <Trans>
              Its shared link stops working and its cards in chat show it as deleted. This can't be
              undone.
            </Trans>
          }
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync({ pageId: deleting.id });
            setDeleting(null);
          }}
        />
      ) : null}
    </div>
  );
}
