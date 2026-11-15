import { describe, expect, it } from "vitest";
import { BotSecretDestination, BotSecretMetadata, BotSecretPutInput } from "./bot-secrets.js";
import { appContract } from "./rpc.js";

const lanPut = {
  botId: "bot-1",
  destination: { name: "router", origin: "http://192.168.1.20:8080", auth: { type: "bearer" } },
  value: "fake-value-1",
};

describe("botSecrets rpc contract", () => {
  it("accepts a LAN http destination structurally and leaves origin rules to the server", () => {
    expect(BotSecretPutInput.safeParse(lanPut).success).toBe(true);
    // The default destination schema (no private-HTTP opt-in) rejects the same origin.
    expect(BotSecretDestination.safeParse(lanPut.destination).success).toBe(false);
  });

  it("still enforces the name pattern, auth shape and value bounds", () => {
    const bad = [
      { ...lanPut, destination: { ...lanPut.destination, name: "Router" } },
      { ...lanPut, destination: { ...lanPut.destination, auth: { type: "cookie" } } },
      { ...lanPut, value: "" },
      { ...lanPut, value: "x".repeat(16_385) },
      { ...lanPut, destination: { ...lanPut.destination, origin: "x".repeat(2049) } },
    ];
    for (const input of bad) expect(BotSecretPutInput.safeParse(input).success).toBe(false);
  });

  it("accepts auth null and a loose stored name in metadata output", () => {
    const parsed = BotSecretMetadata.parse({
      name: "Legacy Name With Spaces",
      origin: "https://api.example.com",
      auth: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(parsed.auth).toBeNull();
    expect(parsed.name).toBe("Legacy Name With Spaces");
  });

  it("accepts a non-regex stored name for remove but keeps put input strict", () => {
    const removeInput = appContract.botSecrets.remove["~orpc"].inputSchema;
    if (!removeInput) throw new Error("remove input schema missing");
    expect(removeInput.safeParse({ botId: "bot-1", name: "Legacy Name" }).success).toBe(true);
    expect(removeInput.safeParse({ botId: "bot-1", name: "" }).success).toBe(false);
    expect(removeInput.safeParse({ botId: "bot-1", name: "x".repeat(257) }).success).toBe(false);
    expect(
      BotSecretPutInput.safeParse({
        ...lanPut,
        destination: { ...lanPut.destination, name: "Legacy Name" },
      }).success,
    ).toBe(false);
  });

  it("has no value field and strips any value or ciphertext from output", () => {
    expect(Object.keys(BotSecretMetadata.shape).sort()).toEqual([
      "allBots",
      "alsoOn",
      "auth",
      "botIds",
      "createdAt",
      "name",
      "note",
      "origin",
      "policy",
      "preview",
      "title",
      "updatedAt",
    ]);
    const parsed = BotSecretMetadata.parse({
      name: "router",
      origin: "http://192.168.1.20:8080",
      auth: { type: "bearer" },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      value: "fake-value-1",
      ciphertext: "enc:1",
    });
    expect(parsed).not.toHaveProperty("value");
    expect(parsed).not.toHaveProperty("ciphertext");
  });

  it("never carries a card's number or security code in a preview", () => {
    const parsed = BotSecretMetadata.parse({
      name: "visa-4242",
      origin: "",
      auth: { type: "card" },
      preview: {
        card: {
          brand: "Visa",
          last4: "4242",
          expMonth: 8,
          expYear: 2030,
          number: "4242424242424242",
          cvc: "123",
        },
      },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(JSON.stringify(parsed)).not.toContain("4242424242424242");
    expect(parsed.preview?.card).not.toHaveProperty("cvc");
  });
});
