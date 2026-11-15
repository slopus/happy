import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { createThreadEvents } from "./events.js";
import type { PrismaClient } from "./generated/prisma/client.js";

function fanout() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    realtime: {
      subscribe: async (topic: string, listener: () => void) => {
        const set = listeners.get(topic) ?? new Set();
        listeners.set(topic, set);
        set.add(listener);
        return async () => {
          set.delete(listener);
        };
      },
      publish: async (topic: string) => {
        for (const listener of listeners.get(topic) ?? []) listener();
      },
    } as unknown as RealtimeFanout,
  };
}

describe("account incoming-call signals", () => {
  it("delivers initial state, retains changes during a snapshot, and isolates users", async () => {
    const { realtime, listeners } = fanout();
    const events = createThreadEvents({} as PrismaClient, realtime);
    const controller = new AbortController();
    const stream = events.followIncomingCalls!("user-1", controller.signal);
    expect((await stream.next()).done).toBe(false);
    await events.notifyIncomingCalls!("user-1");
    expect((await stream.next()).done).toBe(false);
    const next = stream.next();
    await events.notifyIncomingCalls!("user-2");
    controller.abort();
    expect((await next).done).toBe(true);
    expect(listeners.get("incoming-calls:user-1")?.size).toBe(0);
  });
});
