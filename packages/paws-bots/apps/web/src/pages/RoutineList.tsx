import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import type { CronLabels } from "@rakazo/core";
import { ENGLISH_CRON_LABELS, formatCron } from "@rakazo/core";
import { Button, Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@rakazo/ui-web";
import type { LucideIcon } from "lucide-react";
import {
  Clock,
  Eye,
  GitBranch,
  Globe,
  Mail,
  MessageSquare,
  Pause,
  Plus,
  Repeat,
} from "lucide-react";
import { cronLabels } from "../lib/cron";

export function routineTriggerSummary(
  routine: Routine,
  labels: CronLabels = ENGLISH_CRON_LABELS,
): string {
  if (!routine.active) return t`Paused`;
  // Schedules first: they say when it runs, so they matter most when the line is cut off.
  const parts: string[] = routine.crons.map((cron) => formatCron(cron, labels));
  if (routine.watch) parts.push(t`When something changes`);
  if (routine.messageProvider === "slack") parts.push(t`Slack message`);
  else if (routine.messageProvider === "teams") parts.push(t`Teams message`);
  else if (routine.messageProvider) parts.push(t`Message event`);
  if (routine.emailSenders) parts.push(t({ message: "Email", context: "routine trigger" }));
  if (routine.webhookEnabled) parts.push(t`When a webhook fires`);
  if (routine.githubEnabled) parts.push(t`Git event`);
  return parts.length > 0 ? parts.join(", ") : t`No trigger`;
}

/** The icon of the trigger the summary leads with. */
function routineTriggerIcon(routine: Routine): LucideIcon {
  if (routine.crons.length > 0) return Clock;
  if (routine.watch) return Eye;
  if (routine.messageProvider) return MessageSquare;
  if (routine.emailSenders) return Mail;
  if (routine.webhookEnabled) return Globe;
  if (routine.githubEnabled) return GitBranch;
  return Clock;
}

export function RoutineList({
  routines,
  loaded,
  runningRoutineId,
  onCreate,
  onEdit,
  onStop,
}: {
  routines: Routine[];
  /** False while a bot's routines are still loading for the first time. */
  loaded: boolean;
  runningRoutineId?: string;
  onCreate: () => void;
  onEdit: (routine: Routine) => void;
  onStop: () => void;
}) {
  // An empty list is only "no routines" once the bot's routines have loaded. Until then, or
  // when that read fails, the plain list still offers Create routine.
  if (routines.length === 0 && loaded) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Repeat />
          </EmptyMedia>
          <EmptyTitle>
            <Trans>No routines yet</Trans>
          </EmptyTitle>
        </EmptyHeader>
        <Button variant="outline" data-testid="routine-create-button" onClick={onCreate}>
          <Plus />
          <Trans>Create routine</Trans>
        </Button>
      </Empty>
    );
  }
  return (
    <div>
      {routines.map((routine) => (
        <RoutineListRow
          key={routine.id}
          routine={routine}
          running={runningRoutineId === routine.id}
          onOpen={() => onEdit(routine)}
          onStop={onStop}
        />
      ))}
      <button
        type="button"
        data-testid="routine-create-button"
        onClick={onCreate}
        className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start text-body-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <span className="grid h-5 w-5 place-items-center">
          <Plus size={16} strokeWidth={1.6} aria-hidden />
        </span>
        <Trans>Create routine</Trans>
      </button>
    </div>
  );
}

function RoutineListRow({
  routine,
  running,
  onOpen,
  onStop,
}: {
  routine: Routine;
  running: boolean;
  onOpen: () => void;
  onStop: () => void;
}) {
  const { i18n } = useLingui();
  const scheduleLabels = cronLabels(i18n.locale);
  const TriggerIcon = routineTriggerIcon(routine);
  return (
    <div className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2.5 hover:bg-accent">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-start"
      >
        <span className="grid h-5 w-5 place-items-center">
          {routine.active ? (
            <TriggerIcon size={16} strokeWidth={1.6} className="text-success" aria-hidden />
          ) : (
            <Pause size={14} className="text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium text-foreground" dir="auto">
            {routine.name}
          </span>
          <span className="flex min-w-0 gap-2 text-body-sm text-muted-foreground/80">
            <span className="truncate">{routineTriggerSummary(routine, scheduleLabels)}</span>
            {routine.modelProvider && routine.modelId ? (
              <span className="truncate">{routine.modelId}</span>
            ) : null}
          </span>
        </span>
      </button>
      {running ? (
        <>
          <span className="shrink-0 text-body-sm text-warning">
            <Trans>Running</Trans>
          </span>
          <Button
            size="xs"
            onClick={onStop}
            className="shrink-0 bg-warning/15 text-warning hover:bg-warning/25"
          >
            <Trans>Stop</Trans>
          </Button>
        </>
      ) : null}
    </div>
  );
}
