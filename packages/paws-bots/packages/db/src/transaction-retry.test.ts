import { describe, expect, it, vi } from "vitest";
import { withTransactionRetry } from "./transaction-retry.js";

const conflict = (code: string) => Object.assign(new Error("transaction failed"), { code });
const driverConflict = (originalCode: string) =>
  Object.assign(new Error("transaction failed"), {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode } } },
  });

describe("withTransactionRetry", () => {
  it.each([
    ["a Prisma write conflict or deadlock", conflict("P2034")],
    ["a Postgres deadlock", driverConflict("40P01")],
    ["a Postgres serialization failure", driverConflict("40001")],
    [
      "a serialization failure at commit, unwrapped",
      Object.assign(new Error("TransactionWriteConflict"), {
        name: "DriverAdapterError",
        cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
      }),
    ],
    [
      "a transaction that never started",
      Object.assign(
        new Error("Transaction API error: Unable to start a transaction in the given time."),
        { code: "P2028" },
      ),
    ],
  ])("retries %s", async (_, error) => {
    const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("committed");

    await expect(withTransactionRetry(operation)).resolves.toBe("committed");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("gives up after three conflicting attempts", async () => {
    const error = conflict("P2034");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withTransactionRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry a transaction that expired after it started", async () => {
    const error = Object.assign(
      new Error("Transaction API error: A query cannot be executed on an expired transaction."),
      { code: "P2028" },
    );
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withTransactionRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("does not retry other failures", async () => {
    const error = conflict("P2002");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withTransactionRetry(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });
});
