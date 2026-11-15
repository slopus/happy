import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";

/** Cancel executor tool work before closing an interrupted runtime's iterator. */
export async function* withRuntimeCleanup(
  events: AsyncIterable<AgentRuntimeEvent>,
  controller: AbortController,
): AsyncIterable<AgentRuntimeEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        complete = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!complete) {
      // for-await's implicit return() would otherwise run before the executor's
      // finally, potentially waiting on a tool whose signal is still live.
      controller.abort();
      await iterator.return?.();
    }
  }
}
