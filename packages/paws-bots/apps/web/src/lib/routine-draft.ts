import { t } from "@lingui/core/macro";
import type { Routine, RoutineWatch, RoutineWatchInput } from "@rakazo/contracts";
import { ROUTINE_WATCH_DEFAULT_MINUTES, RoutineWatchSchema } from "@rakazo/contracts";
import type { RoutineDraft } from "@rakazo/core";
import { draftFromRoutine, emptyRoutineDraft, isOneShotRoutineCrons } from "@rakazo/core";
import { modelOptionKey } from "./model-catalog";

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultArmRunAtLocal(): string {
  return toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));
}

export function routineNeedsOneShotArm(
  routine: Pick<Routine, "nextRunAt" | "lastRunAt">,
  crons: string[],
) {
  return isOneShotRoutineCrons(crons) && !routine.nextRunAt && !routine.lastRunAt;
}

export type RoutineDraftState = RoutineDraft & {
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  runAtLocal: string;
  /** Empty runs this routine on the bot's model. */
  modelKey: string;
  thinkingLevel: string;
  /** Null unless the routine starts when something changes. */
  watch: RoutineWatchDraft | null;
};

/** The change trigger as the editor holds it: free text until saved. */
export type RoutineWatchDraft = {
  kind: RoutineWatch["kind"];
  /** One path per line. */
  paths: string;
  command: string;
  url: string;
  tool: string;
  /** JSON object of arguments for the tool. */
  args: string;
  /** Comma-separated field names; see RoutineWatch.track. */
  track: string;
  everyMinutes: number;
  loud: boolean;
};

export function emptyWatchDraft(): RoutineWatchDraft {
  return {
    kind: "files",
    paths: "",
    command: "",
    url: "",
    tool: "",
    args: "{}",
    track: "",
    everyMinutes: ROUTINE_WATCH_DEFAULT_MINUTES,
    loud: false,
  };
}

function watchDraftFromRoutine(watch: RoutineWatch | null): RoutineWatchDraft | null {
  if (!watch) return null;
  return {
    kind: watch.kind,
    paths: (watch.paths ?? []).join("\n"),
    command: watch.command ?? "",
    url: watch.url ?? "",
    tool: watch.tool ?? "",
    args: JSON.stringify(watch.args ?? {}),
    track: (watch.track ?? []).join(", "),
    everyMinutes: watch.everyMinutes,
    loud: watch.loud,
  };
}

/** The draft as the api takes it, or the reason it cannot be saved. */
export function watchFromDraft(
  draft: RoutineWatchDraft,
): { watch: RoutineWatchInput } | { error: string } {
  const base = { kind: draft.kind, everyMinutes: draft.everyMinutes, loud: draft.loud };
  const fields = draft.track
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const track = fields.length ? { track: fields } : {};
  if (draft.kind === "files") {
    const paths = draft.paths
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    if (!paths.length) return { error: t`Add a file or folder to watch` };
    return { watch: { ...base, paths } };
  }
  if (draft.kind === "command") {
    if (!draft.command.trim()) return { error: t`Add a command to run` };
    return { watch: { ...base, command: draft.command.trim(), ...track } };
  }
  if (draft.kind === "http") {
    const parsed = RoutineWatchSchema.safeParse({ kind: "http", url: draft.url.trim() });
    if (!parsed.success) return { error: t`Enter an HTTPS URL` };
    return { watch: { ...base, url: parsed.data.url, ...track } };
  }
  if (!draft.tool.trim()) return { error: t`Pick a tool to check` };
  let args: unknown;
  try {
    args = JSON.parse(draft.args.trim() || "{}");
  } catch {
    return { error: t`Tool arguments must be JSON` };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { error: t`Tool arguments must be a JSON object` };
  }
  return {
    watch: { ...base, tool: draft.tool.trim(), args: args as Record<string, unknown>, ...track },
  };
}

export function emptyRoutineDraftState(): RoutineDraftState {
  return {
    ...emptyRoutineDraft(),
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    runAtLocal: "",
    modelKey: "",
    thinkingLevel: "",
    watch: null,
  };
}

export function draftStateFromRoutine(routine: Routine): RoutineDraftState {
  return {
    ...draftFromRoutine(routine),
    webhookEnabled: routine.webhookEnabled,
    githubEnabled: routine.githubEnabled,
    messageProvider: routine.messageProvider,
    runAtLocal: routineNeedsOneShotArm(routine, routine.crons) ? defaultArmRunAtLocal() : "",
    modelKey:
      routine.modelProvider && routine.modelId
        ? modelOptionKey(routine.modelProvider, routine.modelId)
        : "",
    thinkingLevel: routine.thinkingLevel ?? "",
    watch: watchDraftFromRoutine(routine.watch),
  };
}
