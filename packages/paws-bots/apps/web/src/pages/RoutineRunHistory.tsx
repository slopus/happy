import { Trans, useLingui } from "@lingui/react/macro";
import type { RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import {
  formatRoutineRunAt,
  isRetryableError,
  mergeRoutineRunPages,
  normalizeRunError,
  routineHistoryPage,
  routineRunAt,
  routineRunLateness,
} from "@rakazo/core";
import { translateRunError } from "@rakazo/i18n/run-error";
import { Button, SectionHeading, Spinner } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useSpaceQueries } from "../lib/query";
import { statusLabel, statusTone } from "./ActivityList";

export function RoutineRunHistory({ routineId }: { routineId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const history = useInfiniteQuery(
    queries.routines.history.infiniteOptions({
      input: (before: RoutineRunCursor | null) => routineHistoryPage(routineId, before),
      initialPageParam: null as RoutineRunCursor | null,
      getNextPageParam: (page) => page.nextCursor,
      // Polls every loaded page together so they stay one coherent list; a refused request stops.
      refetchInterval: (query) =>
        query.state.error && !isRetryableError(query.state.error) ? false : 15_000,
    }),
  );
  const runs = history.data ? mergeRoutineRunPages(history.data.pages) : null;
  // A routine that has never run has no history to show.
  if (runs?.length === 0 && !history.isError) return null;

  return (
    <section data-testid="routine-run-history" className="mt-10 text-body text-muted-foreground">
      <SectionHeading>
        <Trans>Run history</Trans>
      </SectionHeading>
      {history.isError ? (
        <p role="alert" className="mt-2 text-body text-destructive">
          <Trans>Could not load run history</Trans>
        </p>
      ) : null}
      {runs === null ? (
        history.isPending ? (
          <p className="mt-2 text-body">
            <Spinner aria-label={t`Loading…`} />
          </p>
        ) : null
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
      {history.hasNextPage ? (
        <Button
          variant="text"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
          className="mt-1 font-normal"
        >
          <Trans>Load older runs</Trans>
        </Button>
      ) : null}
    </section>
  );
}

function RunRow({ run }: { run: RoutineRun }) {
  const { i18n, t } = useLingui();
  const locale = i18n.locale || "en";
  const at = routineRunAt(run);
  const late = routineRunLateness(run);
  const count = late?.count;
  const lateLabel = !late
    ? null
    : late.unit === "minutes"
      ? t`Started ${count}m late`
      : late.unit === "hours"
        ? t`Started ${count}h late`
        : t`Started ${count}d late`;
  const chatTo = run.messageId
    ? run.groupId
      ? `/app/g/${encodeURIComponent(run.groupId)}?m=${encodeURIComponent(run.messageId)}`
      : `/app/${encodeURIComponent(run.botId)}?m=${encodeURIComponent(run.messageId)}`
    : null;
  const line = (
    <>
      <time dateTime={at} title={new Date(at).toLocaleString(locale)} className="text-foreground">
        {formatRoutineRunAt(run, locale)}
      </time>
      {lateLabel ? <span>{lateLabel}</span> : null}
      {run.status !== "completed" ? (
        <span className={`ml-auto ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
      ) : chatTo ? null : (
        <span className="ml-auto">{t`No reply`}</span>
      )}
      {chatTo ? (
        <ChevronRight
          aria-hidden
          className={`size-4 shrink-0 ${run.status === "completed" ? "ml-auto" : ""}`}
        />
      ) : null}
    </>
  );
  const lineClass = "-mx-2 flex items-center gap-3 rounded-md px-2 py-2";
  return (
    <li data-testid="routine-run-row" className="text-body-sm">
      {chatTo ? (
        <Link to={chatTo} className={`${lineClass} hover:bg-accent`}>
          {line}
        </Link>
      ) : (
        <div className={lineClass}>{line}</div>
      )}
      {run.status === "failed" && run.error ? (
        <div className="-mt-1 pb-2 text-destructive">
          <p>{normalizeRunError(run.error, translateRunError, locale).summary}</p>
          <details key={run.error} className="mt-1">
            <summary className="w-fit cursor-pointer">{t`Details`}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-label">{run.error}</pre>
          </details>
        </div>
      ) : null}
    </li>
  );
}
