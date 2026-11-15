import type { Run } from "@rakazo/contracts";
import type {
  LogoAvatarActivity,
  LogoAvatarEvent,
  LogoAvatarSignals,
} from "./logo-avatar-activity.js";
import {
  initialLogoAvatarSignals,
  logoAvatarActivity,
  reduceLogoAvatarSignals,
} from "./logo-avatar-activity.js";
import { isBackgroundRunTrigger, isRunWaitingOnUser, isRunWorking } from "./run-state.js";

type ActivityRun = Pick<Run, "id" | "botId" | "status" | "trigger">;
export interface LogoAvatarActivitySnapshot {
  threadId: string;
  cursor: number;
  botId?: string;
  run?: ActivityRun | null;
  activeRuns?: readonly ActivityRun[];
}

/** The status fallback deliberately never invents reading, typing or thinking. */
export function logoAvatarStatusActivity(status?: string): LogoAvatarActivity {
  if (status === "failed") return "error";
  if (status && isRunWaitingOnUser(status)) return "waiting";
  return status && isRunWorking(status) ? "working" : "idle";
}

const PRIORITY: Record<LogoAvatarActivity, number> = {
  computer: 8,
  writing: 7,
  reading: 6,
  thinking: 5,
  working: 4,
  waiting: 3,
  error: 2,
  idle: 1,
};

/**
 * Per-app live activity projection. Sources own thread lifetimes, while one cursor
 * per thread deduplicates overlapping chat/call feeds. Snapshots and reconnects
 * discard live provider/tool/composing detail: old events never become current activity.
 */
export function createLogoAvatarActivityStore() {
  const threads = new Map<
    string,
    {
      cursor: number;
      owners: Set<string>;
      runs: Map<string, { signals: LogoAvatarSignals; stamp: number }>;
      idleBots: Set<string>;
    }
  >();
  const sources = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  let activities = new Map<string, LogoAvatarActivity>();
  let backgroundOnly = new Set<string>();
  let stamp = 0;

  const publish = () => {
    const grouped = new Map<string, { signals: LogoAvatarSignals; stamp: number }[]>();
    const next = new Map<string, LogoAvatarActivity>();
    const nextBackgroundOnly = new Set<string>();
    for (const thread of threads.values()) {
      for (const botId of thread.idleBots) next.set(botId, "idle");
      for (const run of thread.runs.values()) {
        const list = grouped.get(run.signals.botId) ?? [];
        list.push(run);
        grouped.set(run.signals.botId, list);
      }
    }
    for (const [botId, all] of grouped) {
      const foreground = all.filter(({ signals }) => !signals.background);
      if (!foreground.length) nextBackgroundOnly.add(botId);
      const active = foreground.filter(
        ({ signals }) => isRunWorking(signals.status) || isRunWaitingOnUser(signals.status),
      );
      if (active.length) {
        let selected: LogoAvatarActivity = "idle";
        for (const run of active) {
          const activity = logoAvatarActivity(run.signals);
          if (PRIORITY[activity] > PRIORITY[selected]) selected = activity;
        }
        next.set(botId, selected);
      } else {
        const latest = foreground.reduce<(typeof foreground)[number] | undefined>(
          (previous, run) => (!previous || run.stamp > previous.stamp ? run : previous),
          undefined,
        );
        next.set(botId, latest?.signals.status === "failed" ? "error" : "idle");
      }
    }
    if (
      next.size === activities.size &&
      [...next].every(([botId, value]) => activities.get(botId) === value) &&
      nextBackgroundOnly.size === backgroundOnly.size &&
      [...nextBackgroundOnly].every((botId) => backgroundOnly.has(botId))
    )
      return;
    activities = next;
    backgroundOnly = nextBackgroundOnly;
    for (const listener of listeners) listener();
  };
  const own = (source: string, threadId: string) => {
    let thread = threads.get(threadId);
    if (!thread) {
      thread = { cursor: -1, owners: new Set(), runs: new Map(), idleBots: new Set() };
      threads.set(threadId, thread);
    }
    thread.owners.add(source);
    const owned = sources.get(source) ?? new Set<string>();
    owned.add(threadId);
    sources.set(source, owned);
    return thread;
  };
  const projectSnapshot = (
    thread: NonNullable<ReturnType<typeof threads.get>>,
    snapshot: LogoAvatarActivitySnapshot,
  ) => {
    thread.cursor = snapshot.cursor;
    thread.runs.clear();
    thread.idleBots.clear();
    if (snapshot.botId) thread.idleBots.add(snapshot.botId);
    for (const run of [snapshot.run, ...(snapshot.activeRuns ?? [])]) {
      if (!run) continue;
      thread.runs.set(run.id, {
        signals: {
          ...initialLogoAvatarSignals(run.botId),
          runId: run.id,
          status: run.status,
          cursor: snapshot.cursor,
          background: isBackgroundRunTrigger(run.trigger),
        },
        stamp: ++stamp,
      });
    }
    publish();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getActivity(botId: string, status?: string): LogoAvatarActivity {
      const known = activities.get(botId);
      // An idle observed chat cannot rule out public work in an unobserved group.
      // Background-only observations retain their existing privacy suppression.
      if (known && (known !== "idle" || backgroundOnly.has(botId))) return known;
      return logoAvatarStatusActivity(status);
    },
    hydrate(source: string, snapshot: LogoAvatarActivitySnapshot) {
      const thread = own(source, snapshot.threadId);
      if (snapshot.cursor <= thread.cursor) return;
      projectSnapshot(thread, snapshot);
    },
    reconcile(snapshot: LogoAvatarActivitySnapshot) {
      const thread = threads.get(snapshot.threadId);
      if (thread && snapshot.cursor > thread.cursor) projectSnapshot(thread, snapshot);
    },
    apply(source: string, event: LogoAvatarEvent) {
      if (event.type === "heartbeat") return;
      const thread = own(source, event.threadId);
      if (event.seq <= thread.cursor) return;
      thread.cursor = event.seq;
      if (event.type === "thread.cleared") {
        for (const run of thread.runs.values()) thread.idleBots.add(run.signals.botId);
        if (event.botId) thread.idleBots.add(event.botId);
        thread.runs.clear();
        publish();
        return;
      }
      if (!event.botId || !event.runId) return;
      const previous = thread.runs.get(event.runId);
      // A missed run start/absent snapshot has unknown provenance, including whether
      // it is background work. Keep the status fallback generic until reconciled.
      if (!previous && event.type !== "run.started") return;
      const signals = reduceLogoAvatarSignals(
        previous?.signals ?? initialLogoAvatarSignals(event.botId),
        event,
      );
      if (previous?.signals === signals) return;
      thread.idleBots.delete(event.botId);
      thread.runs.set(event.runId, { signals, stamp: ++stamp });
      if (!isRunWorking(signals.status) && !isRunWaitingOnUser(signals.status)) {
        for (const [runId, old] of thread.runs) {
          if (
            runId !== event.runId &&
            old.signals.botId === event.botId &&
            old.signals.background === signals.background &&
            !isRunWorking(old.signals.status) &&
            !isRunWaitingOnUser(old.signals.status)
          )
            thread.runs.delete(runId);
        }
      }
      publish();
    },
    resetSource(source: string) {
      for (const threadId of sources.get(source) ?? []) {
        const thread = threads.get(threadId);
        if (!thread) continue;
        thread.owners.delete(source);
        if (!thread.owners.size) threads.delete(threadId);
      }
      sources.delete(source);
      publish();
    },
    clear() {
      threads.clear();
      sources.clear();
      publish();
    },
  };
}
export type LogoAvatarActivityStore = ReturnType<typeof createLogoAvatarActivityStore>;
