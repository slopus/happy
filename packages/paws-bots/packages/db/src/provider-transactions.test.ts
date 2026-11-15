import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureProviderTransactionPool,
  createProviderTransactionGate,
  ProviderTransactionBusyError,
  providerTransactionSlots,
  runProviderTransaction,
} from "./provider-transactions.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createProviderTransactionGate", () => {
  it("runs one transaction per scope at a time and hands the slot to the next waiter", async () => {
    const gate = createProviderTransactionGate(1);
    const provider = deferred();
    const order: string[] = [];

    const first = gate.run(
      "gmail",
      async () => {
        order.push("first started");
        await provider.promise;
        order.push("first finished");
      },
      1_000,
    );
    const second = gate.run(
      "gmail",
      async () => {
        order.push("second started");
      },
      1_000,
    );

    await Promise.resolve();
    expect(order).toEqual(["first started"]);
    provider.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first started", "first finished", "second started"]);
  });

  it("runs a transaction for another scope while one scope's provider call hangs", async () => {
    vi.useFakeTimers();
    const gate = createProviderTransactionGate(2);
    const provider = deferred();
    const started = vi.fn();

    const holder = gate.run("gmail", () => provider.promise, 60_000);
    const other = gate.run("slack", async () => started(), 2_000);
    await other;

    expect(started).toHaveBeenCalledTimes(1);
    provider.resolve();
    await holder;
  });

  it("queues a second transaction for a busy scope even with slots free", async () => {
    vi.useFakeTimers();
    const gate = createProviderTransactionGate(2);
    const provider = deferred();
    const started = vi.fn();

    const holder = gate.run("gmail", () => provider.promise, 60_000);
    const sameScope = gate.run("gmail", async () => started(), 2_000);
    const rejected = expect(sameScope).rejects.toBeInstanceOf(ProviderTransactionBusyError);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;

    expect(started).not.toHaveBeenCalled();
    provider.resolve();
    await holder;
  });

  it("caps how many scopes hold a connection, however many wait", async () => {
    vi.useFakeTimers();
    const gate = createProviderTransactionGate(2);
    const gmail = deferred();
    const slack = deferred();
    const started = vi.fn();

    const holders = [
      gate.run("gmail", () => gmail.promise, 60_000),
      gate.run("slack", () => slack.promise, 60_000),
    ];
    const third = gate.run("notion", async () => started(), 2_000);
    const rejected = expect(third).rejects.toBeInstanceOf(ProviderTransactionBusyError);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;

    expect(started).not.toHaveBeenCalled();
    // Freeing one scope admits the waiting scope.
    gmail.resolve();
    await holders[0];
    const thirdRetry = gate.run("notion", async () => started(), 2_000);
    await thirdRetry;
    expect(started).toHaveBeenCalledTimes(1);
    slack.resolve();
    await holders[1];
  });

  it("stops a waiter after its wait without starting it, and keeps the slot usable", async () => {
    vi.useFakeTimers();
    const gate = createProviderTransactionGate(1);
    const provider = deferred();
    const started = vi.fn();

    const holder = gate.run("gmail", () => provider.promise, 60_000);
    const waiter = gate.run("gmail", async () => started(), 2_000);
    const rejected = expect(waiter).rejects.toBeInstanceOf(ProviderTransactionBusyError);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(started).not.toHaveBeenCalled();

    provider.resolve();
    await holder;
    await expect(gate.run("gmail", async () => "next", 0)).resolves.toBe("next");
  });

  it("frees the slot when the transaction fails", async () => {
    const gate = createProviderTransactionGate(1);
    await expect(
      gate.run(
        "gmail",
        async () => {
          throw new Error("provider failed");
        },
        1_000,
      ),
    ).rejects.toThrow("provider failed");
    await expect(gate.run("gmail", async () => "after", 0)).resolves.toBe("after");
  });
});

describe("providerTransactionSlots", () => {
  it("allows half the pool for provider transactions and always one", () => {
    expect(providerTransactionSlots(1)).toBe(1);
    expect(providerTransactionSlots(2)).toBe(1);
    expect(providerTransactionSlots(4)).toBe(2);
    expect(providerTransactionSlots(10)).toBe(5);
  });
});

describe("configureProviderTransactionPool", () => {
  it("sizes the shared gate from the pool it is given, read when the pool is built", async () => {
    vi.useFakeTimers();
    // A two-connection pool leaves one slot: a second scope must not take the last connection.
    configureProviderTransactionPool(2);
    const held = deferred();
    const first = runProviderTransaction("scope-a", () => held.promise, 2_000);
    const second = runProviderTransaction("scope-b", async () => "ran", 2_000);
    const refused = expect(second).rejects.toBeInstanceOf(ProviderTransactionBusyError);
    await vi.advanceTimersByTimeAsync(2_000);
    await refused;
    held.resolve();
    await first;

    configureProviderTransactionPool(4);
    const again = deferred();
    const blocking = runProviderTransaction("scope-a", () => again.promise, 2_000);
    await expect(runProviderTransaction("scope-b", async () => "ran", 2_000)).resolves.toBe("ran");
    again.resolve();
    await blocking;
  });
});
