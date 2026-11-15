import type { DataTag, QueryKey } from "@tanstack/query-core";
import { QueryClient } from "@tanstack/query-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFresh, writeSaved } from "./query.js";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function key(name: string) {
  return [name] as unknown as DataTag<QueryKey, string, Error>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  client.clear();
});

describe("saves", () => {
  it("are not overwritten by a read that started before them", async () => {
    const older = deferred<string>();
    const queryKey = key("voice/status");
    const queryFn = vi.fn(() => older.promise);
    void client.fetchQuery({ queryKey, queryFn }).catch(() => undefined);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    await writeSaved(client, queryKey, () => "saved");
    older.resolve("before save");
    await older.promise;
    await Promise.resolve();
    expect(client.getQueryData(queryKey)).toBe("saved");
  });

  it("refresh with a request sent after the change, while opening reuses one in flight", async () => {
    const older = deferred<string>();
    const queryKey = key("models/credentials");
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce("after change");
    const read = { queryKey, queryFn };
    const opening = fetchFresh(client, read, { reuse: true });
    const sharing = fetchFresh(client, read, { reuse: true });
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    const fresh = await fetchFresh(client, read);
    older.resolve("before change");
    expect(fresh).toBe("after change");
    expect(queryFn).toHaveBeenCalledTimes(2);
    await Promise.allSettled([opening, sharing]);
    expect(client.getQueryData(queryKey)).toBe("after change");
  });

  it("gives a refresh cancelled by a newer one that newer answer instead of failing", async () => {
    const queryKey = key("fresh-race-test");
    const answers = ["first", "second"];
    const resolvers: Array<() => void> = [];
    const queryFn = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<string>((resolve, reject) => {
          const answer = answers.shift() ?? "later";
          signal.addEventListener("abort", () => reject(signal.reason));
          resolvers.push(() => resolve(answer));
        }),
    );
    const saveRefresh = fetchFresh(client, { queryKey, queryFn });
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    // A live event refreshes the same list while the save's refresh is still out.
    const eventRefresh = fetchFresh(client, { queryKey, queryFn });
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    resolvers[1]?.();
    await expect(saveRefresh).resolves.toBe("second");
    await expect(eventRefresh).resolves.toBe("second");
  });
});
