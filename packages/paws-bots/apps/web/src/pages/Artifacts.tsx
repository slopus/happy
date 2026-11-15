import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Artifact, Bot } from "@rakazo/contracts";
import { artifactPreviewKind } from "@rakazo/contracts";
import { artifactTypeLabel } from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import {
  BotAvatar,
  Button,
  buttonVariants,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  ListSearchInput,
  NativeSelect,
  NativeSelectOption,
  OptionSelect,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { skipToken, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Download,
  FileCode2,
  FileText,
  ImageIcon,
  LayoutGrid,
  List,
  Lock,
  Maximize2,
  Minimize2,
  Search,
  SearchX,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { VideoPreview } from "../components/ArtifactFileCard";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { IconTooltip } from "../components/IconTooltip";
import { PdfViewer } from "../components/PdfViewer";
import { SandboxedHtmlViewer } from "../components/SandboxedHtmlViewer";
import { decodeArtifactBase64, downloadArtifactBytes } from "../lib/artifact-open";
import { takeInitialBootstrap } from "../lib/bootstrap";
import { desktopBridge } from "../lib/desktop";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { createStoredPreference } from "../lib/stored-preference";
import { useObjectUrl } from "../lib/use-object-url";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

type ViewMode = "grid" | "list";
type DateFilter = "all" | "today" | "week" | "month";
const viewModePreference = createStoredPreference<ViewMode>({
  key: "rakazo:artifacts-view-mode",
  parse: (raw) => (raw === "list" ? "list" : "grid"),
  serialize: (mode) => mode,
});
const LIST_PAGE_SIZE = 60;

type ArtifactSummary = Artifact & { versionCount: number };

const NO_BOTS: Bot[] = [];

function matchesCalendarDateFilter(iso: string, filter: DateFilter, now: Date): boolean {
  if (filter === "all") return true;
  const date = new Date(iso);
  if (filter === "today") return date.toDateString() === now.toDateString();
  if (filter === "week") {
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    return date >= startOfWeek;
  }
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

export function ArtifactsPage() {
  const { artifactId } = useParams<{ artifactId?: string }>();
  const navigate = useNavigate();
  const { t } = useLingui();
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const viewMode = viewModePreference.use();
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [madeByBots, setMadeByBots] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ArtifactSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  // The space's bootstrap is where the shell keeps what it last loaded, bots included.
  const bots =
    useQuery({
      queryKey: queries.bootstrap.queryKey({ input: {} }),
      queryFn: () => takeInitialBootstrap(),
      select: (bootstrap) => bootstrap.bots,
    }).data ?? NO_BOTS;
  const listingOptions = queries.artifacts.listSpace.infiniteOptions({
    input: (cursor: string | undefined) => ({
      botId: activeBotId ?? undefined,
      madeByBots,
      ...(cursor ? { cursor } : {}),
      limit: LIST_PAGE_SIZE,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const listing = useInfiniteQuery(listingOptions);
  const items = useMemo(
    () => listing.data?.pages.flatMap((page) => page.items) ?? null,
    [listing.data],
  );
  const nextCursor = listing.data?.pages.at(-1)?.nextCursor ?? null;
  const loadingMore = listing.isFetchingNextPage;
  const loadError =
    listing.error && !listing.data ? errorText(listing.error, t`Could not load artifacts.`) : null;
  // A failed refresh over the cached list is still said; a failed next page keeps Load more.
  const refreshError =
    listing.data && listing.isRefetchError
      ? errorText(listing.error, t`Could not load artifacts.`)
      : null;

  function loadMore() {
    // A failed page keeps what is shown so Load more can be retried.
    if (nextCursor && !listing.isFetchingNextPage) void listing.fetchNextPage();
  }

  useEffect(() => {
    setMaximized(false);
  }, [artifactId]);

  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  const filteredItems = useMemo(() => {
    if (!items) return null;
    const now = new Date();
    const query = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesCalendarDateFilter(item.createdAt, dateFilter, now)) return false;
      if (!query) return true;
      return (
        item.name.toLowerCase().includes(query) ||
        (item.description?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [items, searchQuery, dateFilter]);

  const clientFilterActive = searchQuery.trim().length > 0 || dateFilter !== "all";
  const autoFetchedCursorRef = useRef<string | null>(null);

  useEffect(() => {
    autoFetchedCursorRef.current = null;
  }, [searchQuery, dateFilter, activeBotId, madeByBots]);

  // Search and date filters only see loaded pages, so keep paging until something matches.
  useEffect(() => {
    if (!clientFilterActive || !nextCursor || loadingMore || items === null) return;
    if (filteredItems && filteredItems.length > 0) return;
    if (autoFetchedCursorRef.current === nextCursor) return;
    autoFetchedCursorRef.current = nextCursor;
    void loadMore();
  }, [clientFilterActive, nextCursor, loadingMore, items, filteredItems]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await rpc.artifacts.remove({ artifactId: pendingDelete.id });
      await writeSaved(queryClient, listingOptions.queryKey, (current) => ({
        pages: (current?.pages ?? []).map((page) => ({
          ...page,
          items: page.items.filter((item) => item.id !== pendingDelete.id),
        })),
        pageParams: current?.pageParams ?? [],
      }));
      // Listings for other bots may hold it too; they refresh when next shown.
      void queryClient.invalidateQueries({
        queryKey: queries.artifacts.listSpace.key(),
        refetchType: "none",
      });
      if (artifactId === pendingDelete.id) navigate("/app/artifacts");
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(errorText(error, t`Could not delete this artifact.`));
    } finally {
      setDeleteBusy(false);
    }
  }

  const serverFilterActive = activeBotId !== null || madeByBots;
  const filtersActive = serverFilterActive || clientFilterActive;
  // Nothing to narrow down yet, so the page stays a clean empty state.
  const showFilters = serverFilterActive || (items !== null && (items.length > 0 || !!nextCursor));

  function clearFilters() {
    setSearchQuery("");
    setDateFilter("all");
    setActiveBotId(null);
    setMadeByBots(false);
  }

  const emptyState = (
    <EmptyArtifacts
      filtered={filtersActive}
      onClearFilters={clearFilters}
      nextCursor={nextCursor}
      loadingMore={loadingMore}
      onLoadMore={loadMore}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground/90">
      <header className="app-drag flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        {/* This route is the window's leading edge, so Electron window controls sit in the header. */}
        {desktopBridge() ? <WindowChrome /> : null}
        <div className="flex min-w-fit flex-1 items-center gap-1">
          <IconTooltip label={t`Back`}>
            <Link
              to="/app"
              aria-label={t`Back`}
              className={buttonVariants({
                variant: "ghost",
                size: "icon",
                className: "app-no-drag text-muted-foreground",
              })}
            >
              <ChevronLeft />
            </Link>
          </IconTooltip>
          <h1 className="font-medium text-foreground">
            <Trans>Artifacts</Trans>
          </h1>
        </div>
        {showFilters ? (
          <div className="app-no-drag flex flex-wrap items-center gap-2">
            <SearchToggle query={searchQuery} onQueryChange={setSearchQuery} />
            {bots.length > 1 ? (
              <BotFilter bots={bots} value={activeBotId} onValueChange={setActiveBotId} />
            ) : null}
            <OptionSelect
              aria-label={t`Filter by date`}
              className="w-fit"
              value={dateFilter}
              onValueChange={setDateFilter}
              options={[
                { value: "all", label: t`All time` },
                { value: "today", label: t`Today` },
                { value: "week", label: t`This week` },
                { value: "month", label: t`This month` },
              ]}
            />
            <OptionSelect
              aria-label={t`Filter by who made it`}
              className="w-fit"
              value={madeByBots ? "bots" : "all"}
              onValueChange={(value) => setMadeByBots(value === "bots")}
              options={[
                { value: "all", label: t`All files` },
                { value: "bots", label: t`Made by bots` },
              ]}
            />
            {!artifactId ? (
              <ToggleGroup
                value={[viewMode]}
                onValueChange={([next]) => {
                  if (next) viewModePreference.set(next as ViewMode);
                }}
                spacing={1}
                className="h-8 rounded-lg border border-input p-0.5"
              >
                <IconTooltip label={t`Card view`}>
                  <ToggleGroupItem
                    value="grid"
                    aria-label={t`Card view`}
                    className="aspect-square h-full w-auto min-w-0 rounded-md px-0 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                  >
                    <LayoutGrid className="size-3.5" />
                  </ToggleGroupItem>
                </IconTooltip>
                <IconTooltip label={t`List view`}>
                  <ToggleGroupItem
                    value="list"
                    aria-label={t`List view`}
                    className="aspect-square h-full w-auto min-w-0 rounded-md px-0 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                  >
                    <List className="size-3.5" />
                  </ToggleGroupItem>
                </IconTooltip>
              </ToggleGroup>
            ) : null}
          </div>
        ) : null}
      </header>

      {refreshError ? (
        <p role="alert" className="px-6 py-2 text-body text-destructive">
          {refreshError}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {artifactId ? (
          <>
            {!maximized ? (
              <IndexPane
                items={filteredItems}
                loadError={loadError}
                botsById={botsById}
                selectedId={artifactId}
                onRequestDelete={setPendingDelete}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                empty={emptyState}
              />
            ) : null}
            <PreviewPane
              key={artifactId}
              artifactId={artifactId}
              maximized={maximized}
              onToggleMaximize={() => setMaximized((value) => !value)}
            />
          </>
        ) : (
          <BrowsingPane
            items={filteredItems}
            loadError={loadError}
            viewMode={viewMode}
            botsById={botsById}
            onRequestDelete={setPendingDelete}
            nextCursor={nextCursor}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            empty={emptyState}
          />
        )}
      </div>

      {pendingDelete ? (
        <ConfirmDialog
          onCancel={() => setPendingDelete(null)}
          title={<Trans>Delete "{pendingDelete.name}"?</Trans>}
          description={
            pendingDelete.versionCount > 1 ? (
              <Trans>
                This deletes all {pendingDelete.versionCount} versions of this artifact. This can't
                be undone.
              </Trans>
            ) : (
              <Trans>This can't be undone.</Trans>
            )
          }
          error={deleteError}
          busy={deleteBusy}
          onConfirm={() => void confirmDelete()}
          confirmLabel={deleteBusy ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
        />
      ) : null}
    </div>
  );
}

function BrowsingPane({
  items,
  loadError,
  viewMode,
  botsById,
  onRequestDelete,
  nextCursor,
  loadingMore,
  onLoadMore,
  empty,
}: {
  items: ArtifactSummary[] | null;
  loadError: string | null;
  viewMode: ViewMode;
  botsById: Map<string, Bot>;
  onRequestDelete: (artifact: ArtifactSummary) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  empty: ReactNode;
}) {
  if (items === null) {
    return (
      <div className="grid flex-1 place-items-center text-body text-muted-foreground/80">
        {loadError ?? <Spinner aria-label={t`Loading…`} />}
      </div>
    );
  }
  if (items.length === 0) return empty;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {viewMode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {items.map((item) => (
            <ArtifactCard
              key={item.id}
              artifact={item}
              bot={item.botId ? botsById.get(item.botId) : undefined}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
          {items.map((item) => (
            <ArtifactRow
              key={item.id}
              artifact={item}
              bot={item.botId ? botsById.get(item.botId) : undefined}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </div>
      )}
      {nextCursor ? <LoadMoreButton loading={loadingMore} onClick={onLoadMore} /> : null}
    </div>
  );
}

function LoadMoreButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <div className="mt-4 flex justify-center">
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={onClick}
        aria-label={t`Load more`}
      >
        {loading ? <Spinner aria-label={t`Loading…`} /> : null}
        <Trans>Load more</Trans>
      </Button>
    </div>
  );
}

function EmptyArtifacts({
  filtered,
  onClearFilters,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  filtered: boolean;
  onClearFilters: () => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (nextCursor) {
    return (
      <Empty>
        {loadingMore ? (
          <Spinner aria-label={t`Loading…`} />
        ) : (
          <EmptyDescription>
            <Trans>No matching artifacts on this page.</Trans>
          </EmptyDescription>
        )}
        <LoadMoreButton loading={loadingMore} onClick={onLoadMore} />
      </Empty>
    );
  }
  if (filtered) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>No matching artifacts</Trans>
          </EmptyTitle>
        </EmptyHeader>
        <Button variant="outline" onClick={onClearFilters}>
          <Trans>Clear filters</Trans>
        </Button>
      </Empty>
    );
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia>
          <ArtifactStackArt />
        </EmptyMedia>
        <EmptyTitle>
          <Trans>No artifacts yet</Trans>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>Files your bots create, like reports, docs and images, collect here.</Trans>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ArtifactStackArt() {
  const sheet =
    "absolute bottom-0 flex h-20 w-16 flex-col rounded-xl border border-border bg-card shadow-sm";
  return (
    <div aria-hidden="true" className="relative h-24 w-44">
      <div
        className={`${sheet} start-3 origin-bottom -rotate-10 items-start justify-center ps-3 text-muted-foreground`}
      >
        <ImageIcon className="size-5" strokeWidth={1.6} />
      </div>
      <div
        className={`${sheet} end-3 origin-bottom rotate-10 items-end justify-center pe-3 text-muted-foreground`}
      >
        <FileCode2 className="size-5" strokeWidth={1.6} />
      </div>
      <div className={`${sheet} inset-x-0 mx-auto h-22 w-17 gap-1.5 p-2.5 shadow-md`}>
        <FileText className="mb-1 size-4 text-foreground/80" strokeWidth={1.8} />
        <span className="h-1 w-full rounded-full bg-muted-foreground/25" />
        <span className="h-1 w-4/5 rounded-full bg-muted-foreground/25" />
        <span className="h-1 w-full rounded-full bg-muted-foreground/25" />
        <span className="h-1 w-3/5 rounded-full bg-muted-foreground/25" />
      </div>
    </div>
  );
}

function SearchToggle({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(query.length > 0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!query && document.activeElement !== inputRef.current) setOpen(false);
  }, [query]);

  if (!open && !query) {
    return (
      <IconTooltip label={t`Search`}>
        <Button
          variant="outline"
          size="icon"
          aria-label={t`Search`}
          className="text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          <Search />
        </Button>
      </IconTooltip>
    );
  }
  return (
    <search
      className="w-56 max-w-full animate-in fade-in-0 slide-in-from-right-2 duration-150"
      onBlur={() => {
        if (!query.trim()) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        onQueryChange("");
        setOpen(false);
      }}
    >
      <ListSearchInput
        query={query}
        setQuery={onQueryChange}
        label={t`Search artifacts`}
        placeholder={t`Search artifacts…`}
        inputRef={inputRef}
      />
    </search>
  );
}

const ALL_BOTS = "all";

function BotFilter({
  bots,
  value,
  onValueChange,
}: {
  bots: Bot[];
  value: string | null;
  onValueChange: (botId: string | null) => void;
}) {
  const { t } = useLingui();
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  return (
    <Select
      value={value ?? ALL_BOTS}
      onValueChange={(next) => onValueChange(next === ALL_BOTS || !next ? null : next)}
    >
      <SelectTrigger aria-label={t`Filter by bot`} className="max-w-44">
        <SelectValue>
          {(selected: string) => {
            const bot = botsById.get(selected);
            return bot ? <BotOption bot={bot} /> : t`All bots`;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL_BOTS}>{t`All bots`}</SelectItem>
          {bots.map((bot) => (
            <SelectItem key={bot.id} value={bot.id}>
              <BotOption bot={bot} />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function BotOption({ bot }: { bot: Bot }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BotAvatar
        avatarSet={bot.avatarSet}
        color={bot.color}
        identity={bot.id}
        size={16}
        status={bot.status}
      />
      <span className="truncate">{bot.name}</span>
    </span>
  );
}

function IndexPane({
  items,
  loadError,
  botsById,
  selectedId,
  onRequestDelete,
  nextCursor,
  loadingMore,
  onLoadMore,
  empty,
}: {
  items: ArtifactSummary[] | null;
  loadError: string | null;
  botsById: Map<string, Bot>;
  selectedId: string;
  onRequestDelete: (artifact: ArtifactSummary) => void;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  empty: ReactNode;
}) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-y-auto border-e border-border">
      {items === null ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-body text-muted-foreground/80">
          {loadError ?? <Spinner aria-label={t`Loading…`} />}
        </div>
      ) : items.length === 0 ? (
        empty
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {items.map((item) => (
            <ArtifactRow
              key={item.id}
              artifact={item}
              bot={item.botId ? botsById.get(item.botId) : undefined}
              active={item.id === selectedId}
              onRequestDelete={onRequestDelete}
            />
          ))}
          {nextCursor ? (
            <div className="p-3">
              <LoadMoreButton loading={loadingMore} onClick={onLoadMore} />
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function ArtifactCard({
  artifact,
  bot,
  onRequestDelete,
}: {
  artifact: ArtifactSummary;
  bot: Bot | undefined;
  onRequestDelete: (artifact: ArtifactSummary) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="group relative">
      <Link
        to={`/app/artifacts/${artifact.id}`}
        className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 text-foreground hover:bg-accent/40"
      >
        <div className="flex items-start justify-between">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-accent text-accent-foreground">
            <ArtifactMimeIcon mimeType={artifact.mimeType} />
          </span>
          <div className="flex items-center gap-1.5">
            {artifact.versionCount > 1 ? (
              <span className="rounded-md bg-muted px-2 py-1 text-caption font-semibold text-muted-foreground">
                {`v${artifact.version}`}
              </span>
            ) : null}
            <span className="rounded-md bg-muted px-2 py-1 text-caption font-semibold text-muted-foreground">
              {artifactTypeLabel(artifact.mimeType)}
            </span>
          </div>
        </div>
        <div className="min-w-0">
          <div className="truncate text-body-lg font-semibold">{artifact.name}</div>
          {artifact.description ? (
            <div className="mt-1 line-clamp-2 text-body-sm leading-relaxed text-muted-foreground">
              {artifact.description}
            </div>
          ) : null}
        </div>
        <div className="mt-auto flex items-center gap-2 text-label text-muted-foreground">
          {bot ? (
            <>
              <BotAvatar
                avatarSet={bot.avatarSet}
                color={bot.color}
                identity={bot.id}
                size={20}
                status={bot.status}
              />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
            </>
          ) : (
            <span className="flex-1" />
          )}
          <span className="shrink-0">{formatRelativeTime(artifact.createdAt)}</span>
        </div>
      </Link>
      <IconTooltip label={t`Delete ${artifact.name}`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Delete ${artifact.name}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete(artifact);
          }}
          className="absolute bottom-3 end-3 bg-card text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Trash2 strokeWidth={1.9} />
        </Button>
      </IconTooltip>
    </div>
  );
}

function ArtifactRow({
  artifact,
  bot,
  active,
  onRequestDelete,
}: {
  artifact: ArtifactSummary;
  bot: Bot | undefined;
  active?: boolean;
  onRequestDelete: (artifact: ArtifactSummary) => void;
}) {
  const { t } = useLingui();
  return (
    <div className={`group relative ${active ? "bg-accent/60" : "hover:bg-accent/40"}`}>
      <Link to={`/app/artifacts/${artifact.id}`} className="flex flex-col gap-1 px-4 py-3 pe-10">
        <div className="flex items-center gap-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-accent text-accent-foreground">
            <ArtifactMimeIcon mimeType={artifact.mimeType} small />
          </span>
          <span className="min-w-0 flex-1 truncate text-body font-medium">{artifact.name}</span>
          {artifact.versionCount > 1 ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-caption font-semibold text-muted-foreground">
              {`v${artifact.version}`}
            </span>
          ) : null}
        </div>
        {artifact.description ? (
          <div className="ps-8 text-body-sm leading-snug text-muted-foreground">
            {artifact.description}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 ps-8 text-label text-muted-foreground">
          {bot ? (
            <>
              <BotAvatar
                avatarSet={bot.avatarSet}
                color={bot.color}
                identity={bot.id}
                size={14}
                status={bot.status}
              />
              <span className="me-1 max-w-[140px] truncate">{bot.name}</span>
            </>
          ) : null}
          <span>{formatRelativeTime(artifact.createdAt)}</span>
        </div>
      </Link>
      <IconTooltip label={t`Delete ${artifact.name}`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Delete ${artifact.name}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequestDelete(artifact);
          }}
          className="absolute inset-y-0 end-2 my-auto text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Trash2 strokeWidth={1.9} />
        </Button>
      </IconTooltip>
    </div>
  );
}

function ArtifactMimeIcon({ mimeType, small }: { mimeType: string; small?: boolean }) {
  const size = small ? 12 : 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {mimeType === "text/html" ? (
        <>
          <polyline points="8 6 2 12 8 18" />
          <polyline points="16 6 22 12 16 18" />
        </>
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </>
      )}
    </svg>
  );
}

function PreviewPane({
  artifactId,
  maximized,
  onToggleMaximize,
}: {
  artifactId: string;
  maximized: boolean;
  onToggleMaximize: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const versionsQuery = useQuery(
    queries.artifacts.listVersions.queryOptions({
      input: { familyId: artifactId },
    }),
  );
  const versions = versionsQuery.data ?? null;
  const [pickedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const selectedVersionId =
    pickedVersionId ??
    (versions ? (versions[0]?.id ?? artifactId) : versionsQuery.isError ? artifactId : null);
  const artifactQuery = useQuery(
    queries.artifacts.getById.queryOptions({
      input: selectedVersionId ? { artifactId: selectedVersionId } : skipToken,
    }),
  );
  const bytes = useMemo(
    () => (artifactQuery.data ? decodeArtifactBase64(artifactQuery.data.contentBase64) : null),
    [artifactQuery.data],
  );
  const state:
    | { status: "loading" }
    | { status: "ready"; artifact: Artifact; bytes: Uint8Array }
    | { status: "error"; message: string } =
    artifactQuery.data && bytes
      ? { status: "ready", artifact: artifactQuery.data, bytes }
      : artifactQuery.error
        ? {
            status: "error",
            message: errorText(artifactQuery.error, t`Could not load this artifact.`),
          }
        : { status: "loading" };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-body-lg font-semibold">
            {state.status === "ready" ? state.artifact.name : null}
          </h2>
          {state.status === "ready" && state.artifact.description ? (
            <p className="truncate text-body-sm text-muted-foreground">
              {state.artifact.description}
            </p>
          ) : null}
        </div>
        {versions && versions.length > 1 && selectedVersionId ? (
          <NativeSelect
            aria-label={t`Version`}
            className="w-auto shrink-0 text-body-sm"
            value={selectedVersionId}
            onChange={(event) => setSelectedVersionId(event.target.value)}
          >
            {versions.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {`v${entry.version} (${formatRelativeTime(entry.createdAt)})`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {state.status === "ready" ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadArtifactBytes(state.artifact.name, state.artifact.mimeType, state.bytes)
              }
            >
              <Download className="me-1.5" size={15} strokeWidth={1.9} />
              <Trans>Download</Trans>
            </Button>
            <IconTooltip label={maximized ? t`Show list` : t`Maximize`}>
              <Button
                variant="outline"
                size="icon"
                aria-label={maximized ? t`Show list` : t`Maximize`}
                onClick={onToggleMaximize}
                className="text-muted-foreground"
              >
                {maximized ? (
                  <Minimize2 size={15} strokeWidth={1.9} />
                ) : (
                  <Maximize2 size={15} strokeWidth={1.9} />
                )}
              </Button>
            </IconTooltip>
          </>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 p-5">
        {state.status === "loading" ? (
          <div className="grid h-full place-items-center text-body text-muted-foreground/80">
            <Spinner aria-label={t`Loading…`} />
          </div>
        ) : state.status === "error" ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
            {state.message}
          </div>
        ) : (
          <div className="relative h-full overflow-hidden rounded-2xl border border-border">
            <ArtifactPreview artifact={state.artifact} bytes={state.bytes} />
            {state.artifact.mimeType === "text/html" ? (
              <div className="absolute bottom-3 end-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1.5 text-caption text-white">
                <Lock size={12} strokeWidth={2} />
                <span>
                  <Trans>Isolated preview — no access to your account</Trans>
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactPreview({ artifact, bytes }: { artifact: Artifact; bytes: Uint8Array }) {
  switch (artifactPreviewKind(artifact.mimeType)) {
    case "html":
      return (
        <SandboxedHtmlViewer html={new TextDecoder("utf-8").decode(bytes)} title={artifact.name} />
      );
    case "markdown":
      return (
        <div className="h-full overflow-y-auto bg-background">
          <article className="mx-auto w-full max-w-[760px] px-8 py-10 text-body-lg leading-7 text-foreground">
            <ChatMarkdown>{new TextDecoder("utf-8").decode(bytes)}</ChatMarkdown>
          </article>
        </div>
      );
    case "text":
      return (
        <div className="h-full overflow-auto bg-background">
          <pre className="px-8 py-10 font-mono text-body-sm leading-6 whitespace-pre-wrap break-words text-foreground">
            {new TextDecoder("utf-8").decode(bytes)}
          </pre>
        </div>
      );
    case "pdf":
      return <PdfViewer bytes={bytes} title={artifact.name} />;
    case "video":
      return <VideoPreview bytes={bytes} name={artifact.name} />;
    case "image":
      return <ImagePreview bytes={bytes} mimeType={artifact.mimeType} name={artifact.name} />;
    case "none":
      return (
        <div className="grid h-full place-items-center px-6 text-center text-body text-muted-foreground/80">
          <Trans>Preview isn't available for this file type — download it to view it.</Trans>
        </div>
      );
  }
}

function ImagePreview({
  bytes,
  mimeType,
  name,
}: {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}) {
  const url = useObjectUrl(bytes, mimeType);
  if (!url) return null;
  return (
    <div className="grid h-full place-items-center overflow-auto bg-muted/40 p-4">
      <img src={url} alt={name} className="max-h-full max-w-full rounded-lg shadow-sm" />
    </div>
  );
}
