import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

const context = {
  operationId: "operation",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  signal: new AbortController().signal,
};

describe("EncryptedSecretStore", () => {
  it("derives each record's key once however often it is read", async () => {
    const store = new EncryptedSecretStore("test-only-encryption-key");
    const records = await Promise.all(
      ["one", "two", "three"].map((value) => store.put(value, context, { recordId: value })),
    );
    vi.mocked(crypto.scrypt).mockClear();

    // A list reads every item at once, and the next list reads them all again.
    for (let pass = 0; pass < 2; pass++) {
      await expect(
        Promise.all(records.map((record) => store.load(record.ciphertext, record.id))),
      ).resolves.toEqual(["one", "two", "three"]);
    }
    await expect(store.load(records[0]!.ciphertext, records[0]!.id)).resolves.toBe("one");

    expect(crypto.scrypt).toHaveBeenCalledTimes(3);
  });

  it("still authenticates the record a cached key opens", async () => {
    const store = new EncryptedSecretStore("test-only-encryption-key");
    const record = await store.put("value", context, { recordId: "record" });
    await store.load(record.ciphertext, record.id);

    await expect(store.load(record.ciphertext, "another-record")).rejects.toThrow();
  });
});
