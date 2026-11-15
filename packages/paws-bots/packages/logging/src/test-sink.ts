import type { LogEvent, LogSink } from "./types.js";

export interface TestSink extends LogSink {
  events: LogEvent[];
}

export function createTestSink(): TestSink {
  const events: LogEvent[] = [];
  return {
    events,
    write(event) {
      events.push(event);
    },
  };
}
