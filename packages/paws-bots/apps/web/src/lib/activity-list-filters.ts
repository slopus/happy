import { t } from "@lingui/core/macro";
import type { RunActivityRow, RunStatus } from "@rakazo/contracts";

export type ActivityStatusFilter = RunStatus | "all";

export type ActivityDateRange = {
  from: string;
  to: string;
};

export type ActivityListFilters = {
  query: string;
  status: ActivityStatusFilter;
  dateRange: ActivityDateRange;
};

export const emptyActivityFilters = (): ActivityListFilters => ({
  query: "",
  status: "all",
  dateRange: { from: "", to: "" },
});

export function activityFiltersActive(filters: ActivityListFilters): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.status !== "all" ||
    filters.dateRange.from.length > 0 ||
    filters.dateRange.to.length > 0
  );
}

export function activityPreview(run: RunActivityRow): string {
  if (run.trigger !== "bot_message") return run.promptSnippet;
  if (!run.agentMessage) return run.promptSnippet;
  if (run.agentMessage.kind === "unknown") return t`Message from another agent`;
  const name = run.agentMessage.fromBotName.trim() || t`Another agent`;
  const text = run.agentMessage.text;
  if (run.agentMessage.kind === "update") {
    return text ? t`Update from ${name}: ${text}` : t`Update from ${name}`;
  }
  return text ? t`${name} asked: ${text}` : t`${name} asked`;
}

export function activitySearchHaystack(run: RunActivityRow): string {
  const parts = [run.botName];
  if (run.groupName) {
    parts.push(run.groupName, `${run.botName} ${run.groupName}`);
  }
  parts.push(activityPreview(run));
  return parts.join(" ").toLowerCase();
}

function parseDayStart(isoDate: string): number | null {
  const value = Date.parse(`${isoDate}T00:00:00`);
  return Number.isNaN(value) ? null : value;
}

function parseDayEnd(isoDate: string): number | null {
  const value = Date.parse(`${isoDate}T23:59:59.999`);
  return Number.isNaN(value) ? null : value;
}

export function runMatchesActivityFilters(
  run: RunActivityRow,
  filters: ActivityListFilters,
): boolean {
  const q = filters.query.trim().toLowerCase();
  if (q.length > 0 && !activitySearchHaystack(run).includes(q)) return false;

  if (filters.status !== "all" && run.status !== filters.status) return false;

  const fromMs = filters.dateRange.from ? parseDayStart(filters.dateRange.from) : null;
  const toMs = filters.dateRange.to ? parseDayEnd(filters.dateRange.to) : null;
  if (fromMs == null && toMs == null) return true;

  const runMs = Date.parse(run.updatedAt);
  if (Number.isNaN(runMs)) return false;
  if (fromMs != null && runMs < fromMs) return false;
  if (toMs != null && runMs > toMs) return false;

  return true;
}

export function filterActivityRuns(
  runs: RunActivityRow[],
  filters: ActivityListFilters,
): RunActivityRow[] {
  if (!activityFiltersActive(filters)) return runs;
  return runs.filter((run) => runMatchesActivityFilters(run, filters));
}

export function clearActivityFilterField(
  filters: ActivityListFilters,
  field: "query" | "status" | "from" | "to",
): ActivityListFilters {
  if (field === "query") return { ...filters, query: "" };
  if (field === "status") return { ...filters, status: "all" };
  if (field === "from") return { ...filters, dateRange: { ...filters.dateRange, from: "" } };
  return { ...filters, dateRange: { ...filters.dateRange, to: "" } };
}
