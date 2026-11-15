import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group, RunActivityRow, RunStatus } from "@rakazo/contracts";
import { activitySections, isRetryableError } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  GroupAvatar,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import type { ActivityListFilters } from "../lib/activity-list-filters";
import {
  activityFiltersActive,
  activityPreview,
  clearActivityFilterField,
  emptyActivityFilters,
  filterActivityRuns,
} from "../lib/activity-list-filters";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";

export function statusTone(status: RunActivityRow["status"]): string {
  if (status === "failed") return "text-destructive";
  if (status === "cancelled") return "text-muted-foreground";
  if (status === "completed") return "text-success";
  if (status === "waiting_input" || status === "waiting_takeover") return "text-warning";
  return "text-foreground";
}

const NO_RUNS: RunActivityRow[] = [];

type ActivityListProps = {
  bots: Bot[];
  groups: Group[];
  /** Section keys flipped from their default fold, stored with the sidebar's collapsed groups. */
  toggledSections: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  onOpenRun: (run: RunActivityRow) => void;
  onOpenBot: (bot: Bot) => void;
  onOpenGroup: (group: Group) => void;
  filters: ActivityListFilters;
  onFiltersChange: (next: ActivityListFilters) => void;
  filtersExpanded: boolean;
  filtersId: string;
};

export function ActivityList({
  bots,
  groups,
  toggledSections,
  onToggleSection,
  onOpenRun,
  onOpenBot,
  onOpenGroup,
  filters,
  onFiltersChange,
  filtersExpanded,
  filtersId,
}: ActivityListProps) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // Polls while open; a refused request (signed out, forbidden) stops polling.
  const poll = {
    refetchInterval: (query: { state: { error: unknown } }) =>
      query.state.error && !isRetryableError(query.state.error) ? false : 15_000,
  } as const;
  const active = useQuery(queries.runs.list.queryOptions({ input: { filter: "active" }, ...poll }));
  const recent = useQuery(queries.runs.list.queryOptions({ input: { filter: "recent" }, ...poll }));
  const activeRuns = active.data?.runs ?? NO_RUNS;
  const recentRuns = recent.data?.runs ?? NO_RUNS;
  // "Try again" shows its progress in place of the error it answers.
  const [retrying, setRetrying] = useState(false);
  const loading = active.isPending || recent.isPending || retrying;
  const failure = retrying ? null : (active.error ?? recent.error);
  const error = failure
    ? failure instanceof Error
      ? failure.message
      : t`Could not load activity`
    : null;
  const retry = () => {
    setRetrying(true);
    void Promise.all([active.refetch(), recent.refetch()]).finally(() => setRetrying(false));
  };

  const filteredActive = useMemo(
    () => filterActivityRuns(activeRuns, filters),
    [activeRuns, filters, t],
  );
  const filteredRecent = useMemo(
    () => filterActivityRuns(recentRuns, filters),
    [recentRuns, filters, t],
  );

  const filtersOn = activityFiltersActive(filters);
  const sections = activitySections({
    active: filteredActive,
    recent: filteredRecent,
    bots,
    groups,
  });
  // Filters narrow runs, so unread chats step aside and their matching runs stay in Recent.
  const recentRows = filtersOn ? sections.settled : sections.recent;
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const section = (key: string, title: string, count: number, defaultOpen: boolean) => ({
    title,
    count,
    open: defaultOpen !== toggledSections.has(`activity:${key}`),
    onToggle: () => onToggleSection(`activity:${key}`),
  });
  const runRows = (runs: RunActivityRow[], detailed = false) =>
    runs.map((run) => (
      <ActivityRow
        key={run.runId}
        run={run}
        bot={botsById.get(run.botId)}
        detailed={detailed}
        onOpen={() => onOpenRun(run)}
      />
    ));
  const unreadCount = filtersOn ? 0 : sections.unreadGroups.length + sections.unreadBots.length;
  const hasAnyRuns = activeRuns.length > 0 || recentRuns.length > 0;
  const hasVisibleRuns = filteredActive.length > 0 || filteredRecent.length > 0;

  return (
    <div data-testid="activity-list">
      <ActivityFilters
        filters={filters}
        onChange={onFiltersChange}
        expanded={filtersExpanded}
        id={filtersId}
      />

      {error ? (
        <div className="px-2.5 pb-2" role="alert">
          <ActivityError error={error} onRetry={retry} compact />
        </div>
      ) : null}

      {loading && !hasAnyRuns ? (
        <p className="px-2.5 py-2 text-body-sm text-muted-foreground/80">
          <Spinner aria-label={t`Loading activity…`} />
        </p>
      ) : !error && filtersOn && hasAnyRuns && !hasVisibleRuns ? (
        <p className="px-2.5 py-2 text-body-sm text-muted-foreground/80" role="status">
          <Trans>No runs match these filters.</Trans>
        </p>
      ) : !error && !hasAnyRuns && unreadCount === 0 ? (
        <p className="px-2.5 py-2 text-body-sm text-muted-foreground/80" role="status">
          <Trans>No runs yet</Trans>
        </p>
      ) : null}

      {sections.attention.length > 0 ? (
        <ActivitySection
          {...section("attention", t`Needs attention`, sections.attention.length, true)}
        >
          {runRows(sections.attention)}
        </ActivitySection>
      ) : null}
      {sections.working.length > 0 ? (
        <ActivitySection {...section("working", t`Working`, sections.working.length, false)}>
          {runRows(sections.working)}
        </ActivitySection>
      ) : null}
      {unreadCount > 0 ? (
        <ActivitySection {...section("unread", t`Unread`, unreadCount, false)}>
          {sections.unreadGroups.map((group) => (
            <ChatRow
              key={group.id}
              avatar={<GroupAvatar members={group.members} size={28} />}
              name={group.name}
              preview={group.preview}
              updatedAt={group.updatedAt}
              onOpen={() => onOpenGroup(group)}
            />
          ))}
          {sections.unreadBots.map((bot) => (
            <ChatRow
              key={bot.id}
              avatar={
                <BotAvatar
                  identity={bot.id}
                  color={bot.color}
                  avatarSet={bot.avatarSet}
                  size={28}
                />
              }
              name={bot.name}
              preview={bot.preview}
              updatedAt={bot.updatedAt}
              onOpen={() => onOpenBot(bot)}
            />
          ))}
        </ActivitySection>
      ) : null}
      {recentRows.length > 0 ? (
        <ActivitySection {...section("recent", t`Recent`, recentRows.length, true)}>
          {runRows(recentRows, true)}
        </ActivitySection>
      ) : null}
    </div>
  );
}

const STATUS_FILTERS: RunStatus[] = [
  "running",
  "queued",
  "leased",
  "waiting_input",
  "waiting_takeover",
  "completed",
  "failed",
  "cancelled",
];

function ActivityError({
  error,
  onRetry,
  compact = false,
}: {
  error: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <>
      <p className={`${compact ? "text-body-sm" : "text-body-sm"} text-destructive`}>{error}</p>
      <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </>
  );
}

function ActivityFilters({
  filters,
  onChange,
  expanded,
  id,
}: {
  expanded: boolean;
  id: string;
  filters: ActivityListFilters;
  onChange: (next: ActivityListFilters) => void;
}) {
  const { t } = useLingui();
  const statusId = useId();
  const fromId = useId();
  const toId = useId();
  const filtersOn = activityFiltersActive(filters);
  const statusLabelText = filters.status === "all" ? null : statusLabel(filters.status);

  return (
    <div className="flex flex-col">
      <Collapsible open={expanded} className="contents">
        <CollapsibleContent id={id} keepMounted className="flex flex-col">
          <div className="space-y-2 pt-1 pb-2">
            <div>
              <Label htmlFor={statusId} className="text-body-sm text-muted-foreground/80">
                <Trans>Status</Trans>
              </Label>
              <NativeSelect
                id={statusId}
                data-testid="activity-status-filter"
                value={filters.status}
                onChange={(event) =>
                  onChange({
                    ...filters,
                    status: event.target.value as ActivityListFilters["status"],
                  })
                }
                className="mt-1 w-full"
              >
                <NativeSelectOption value="all">{t`All statuses`}</NativeSelectOption>
                {STATUS_FILTERS.map((status) => (
                  <NativeSelectOption key={status} value={status}>
                    {statusLabel(status)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0">
                <Label htmlFor={fromId} className="text-body-sm text-muted-foreground/80">
                  <Trans>From</Trans>
                </Label>
                <Input
                  id={fromId}
                  data-testid="activity-date-from"
                  type="date"
                  value={filters.dateRange.from}
                  onChange={(event) =>
                    onChange({
                      ...filters,
                      dateRange: { ...filters.dateRange, from: event.target.value },
                    })
                  }
                  className="mt-1 rounded-xl bg-card text-body-sm dark:bg-input"
                />
              </div>
              <div className="min-w-0">
                <Label htmlFor={toId} className="text-body-sm text-muted-foreground/80">
                  <Trans>To</Trans>
                </Label>
                <Input
                  id={toId}
                  data-testid="activity-date-to"
                  type="date"
                  value={filters.dateRange.to}
                  onChange={(event) =>
                    onChange({
                      ...filters,
                      dateRange: { ...filters.dateRange, to: event.target.value },
                    })
                  }
                  className="mt-1 rounded-xl bg-card text-body-sm dark:bg-input"
                />
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {filtersOn ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 pt-1">
          {filters.query.trim() ? (
            <FilterChip
              label={t`Search: ${filters.query.trim()}`}
              onClear={() => onChange(clearActivityFilterField(filters, "query"))}
            />
          ) : null}
          {statusLabelText ? (
            <FilterChip
              label={statusLabelText}
              onClear={() => onChange(clearActivityFilterField(filters, "status"))}
            />
          ) : null}
          {filters.dateRange.from ? (
            <FilterChip
              label={t`From ${filters.dateRange.from}`}
              onClear={() => onChange(clearActivityFilterField(filters, "from"))}
            />
          ) : null}
          {filters.dateRange.to ? (
            <FilterChip
              label={t`To ${filters.dateRange.to}`}
              onClear={() => onChange(clearActivityFilterField(filters, "to"))}
            />
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-label"
            data-testid="activity-reset-filters"
            onClick={() => onChange(emptyActivityFilters())}
          >
            <Trans>Reset all</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-label text-foreground hover:bg-accent"
      onClick={onClear}
      aria-label={t`Clear filter ${label}`}
    >
      <span className="truncate">{label}</span>
      <span aria-hidden>×</span>
    </button>
  );
}

function ActivitySection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <Collapsible open={open} onOpenChange={onToggle}>
        <SectionHeading variant="label">
          <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-2.5 pb-1 pt-1.5 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
            <span className="min-w-0 flex-1 truncate text-start">{title}</span>
            <span className="tabular-nums">{count}</span>
            <ChevronDown
              size={14}
              strokeWidth={1.8}
              className={open ? "transition-transform" : "-rotate-90 transition-transform"}
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        </SectionHeading>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function ActivityRow({
  run,
  bot,
  detailed,
  onOpen,
}: {
  run: RunActivityRow;
  bot?: Bot;
  /** Recent mixes outcomes, so its rows say how each run ended and when. */
  detailed: boolean;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const title = run.groupName ? `${run.botName}, ${run.groupName}` : run.botName;
  const label = statusLabel(run.status);
  const activityLabel = t`${title}, ${label}`;
  const preview = activityPreview(run);
  return (
    <button
      type="button"
      aria-label={activityLabel}
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start hover:bg-accent"
    >
      <BotAvatar
        identity={run.botId}
        color={bot?.color ?? ""}
        avatarSet={bot?.avatarSet}
        status={run.status}
        size={28}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 gap-2 text-body font-medium">
            <span className="truncate text-foreground">{run.botName}</span>
            {run.groupName ? (
              <span className="truncate text-muted-foreground">{run.groupName}</span>
            ) : null}
          </span>
          {detailed ? (
            <span className="shrink-0 text-label text-muted-foreground/80">
              {formatRelativeTime(run.updatedAt)}
            </span>
          ) : null}
        </div>
        <div className="flex items-baseline gap-2">
          {preview ? (
            <span className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground">
              {preview}
            </span>
          ) : null}
          {detailed ? (
            <span className={`ms-auto shrink-0 text-label ${statusTone(run.status)}`}>{label}</span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function ChatRow({
  avatar,
  name,
  preview,
  updatedAt,
  onOpen,
}: {
  avatar: ReactNode;
  name: string;
  preview: string;
  updatedAt: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start hover:bg-accent"
    >
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-body font-medium text-foreground">{name}</span>
          <span className="shrink-0 text-label text-muted-foreground/80">
            {formatRelativeTime(updatedAt)}
          </span>
        </div>
        {preview ? (
          <div className="truncate text-body-sm text-muted-foreground">{preview}</div>
        ) : null}
      </div>
    </button>
  );
}

export function statusLabel(status: RunActivityRow["status"]): string {
  switch (status) {
    case "queued":
      return t`Queued`;
    case "leased":
      return t`Starting`;
    case "running":
      return t`Running`;
    case "waiting_input":
      return t`Needs input`;
    case "waiting_takeover":
      return t`Needs takeover`;
    case "completed":
      return t`Done`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
    default:
      return status;
  }
}
