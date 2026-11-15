import type { DataTag, QueryClient, QueryFunction, QueryKey } from "@tanstack/query-core";
import { hashKey, isCancelledError } from "@tanstack/query-core";

/**
 * Writes what a save confirmed. An older read still in flight is cancelled first, or it could
 * land afterwards and put the value from before the save back on screen.
 */
export async function writeSaved<T, E>(
  client: QueryClient,
  queryKey: DataTag<QueryKey, T, E>,
  update: (current: T | undefined) => T,
): Promise<void> {
  await client.cancelQueries({ queryKey, exact: true });
  client.setQueryData(queryKey, update);
}

/**
 * Reads data again. After a change, a read already in flight started before it, so that read is
 * cancelled rather than reused and the answer comes from a request sent afterwards. `reuse` is
 * for a screen opening, where sharing an in-flight read is fine.
 */
const freshAnswers = new Map<string, Promise<unknown>>();

export async function fetchFresh<T, E>(
  client: QueryClient,
  options: { queryKey: DataTag<QueryKey, T, E>; queryFn: QueryFunction<T> },
  { reuse = false } = {},
): Promise<T> {
  if (reuse) return client.fetchQuery({ ...options, staleTime: 0 });
  // Claimed before cancelling, so a refresh this one cancels can wait for its final answer.
  const key = hashKey(options.queryKey);
  let settle!: (answer: Promise<T>) => void;
  const answer = new Promise<T>((resolve) => {
    settle = resolve;
  });
  answer.catch(() => undefined);
  freshAnswers.set(key, answer);
  const run = (async () => {
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      return await client.fetchQuery({ ...options, staleTime: 0 });
    } catch (error) {
      const newer = freshAnswers.get(key);
      // A newer refresh of the same data cancelled this one; its answer is newer still.
      if (isCancelledError(error) && newer && newer !== answer) return newer as Promise<T>;
      throw error;
    }
  })();
  settle(run);
  try {
    return await run;
  } finally {
    if (freshAnswers.get(key) === answer) freshAnswers.delete(key);
  }
}
