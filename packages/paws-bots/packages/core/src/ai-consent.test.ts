import type { AiConsentStatus } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AiConsentBlocked,
  aiConsentTarget,
  aiConsentTargets,
  aiDataUsesForProcedure,
  ensureAiDataConsent,
} from "./ai-consent.js";

const status: AiConsentStatus = {
  scope: "account-space",
  version: AI_DISCLOSURE_VERSION,
  recipients: [
    {
      key: "model",
      name: "Example AI",
      use: "model",
      detail: "",
      privacyUrl: "https://example.com/privacy",
      allowed: false,
    },
    {
      key: "voice",
      name: "Example Voice",
      use: "voice",
      detail: "",
      privacyUrl: "https://example.com/privacy",
      allowed: false,
    },
  ],
};

describe("foreground AI consent", () => {
  it("identifies a failed preflight separately from a dispatched mutation failure", async () => {
    const check = ensureAiDataConsent({
      uses: ["model"],
      status: async () => {
        throw new Error("Offline");
      },
      prompt: vi.fn(),
      allow: vi.fn(),
    });
    await expect(check).rejects.toBeInstanceOf(AiConsentBlocked);
  });
  it("keeps the preflight failure as the cause so an unreachable server stays recognizable", async () => {
    const offline = new TypeError("Network request failed");
    const check = ensureAiDataConsent({
      uses: ["model"],
      status: async () => {
        throw offline;
      },
      prompt: vi.fn(),
      allow: vi.fn(),
    });
    await expect(check).rejects.toMatchObject({ cause: offline });
  });
  it("does not grant anything when declined", async () => {
    const allow = vi.fn();
    await expect(
      ensureAiDataConsent({
        uses: ["model"],
        status: async () => status,
        prompt: async () => false,
        allow,
      }),
    ).rejects.toThrow();
    expect(allow).not.toHaveBeenCalled();
  });
  it("only grants the disclosed feature after explicit permission, bound to the account and version", async () => {
    const order: string[] = [];
    const allow = vi.fn(async () => {
      order.push("allow");
    });
    await ensureAiDataConsent({
      uses: ["model"],
      status: async () => status,
      prompt: async () => {
        order.push("prompt");
        return true;
      },
      allow,
    });
    expect(order).toEqual(["prompt", "allow"]);
    expect(allow).toHaveBeenCalledExactlyOnceWith({
      scope: status.scope,
      version: status.version,
      keys: ["model"],
    });
  });
  it("does not prompt for already granted permissions or read-only procedures", async () => {
    const prompt = vi.fn();
    await ensureAiDataConsent({
      uses: ["model"],
      status: async () => ({
        ...status,
        recipients: status.recipients.map((item) => ({ ...item, allowed: true })),
      }),
      prompt,
      allow: vi.fn(),
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(aiDataUsesForProcedure("threads/get")).toEqual([]);
    expect(aiDataUsesForProcedure("threads/send")).toEqual(["model", "memory"]);
    expect(aiDataUsesForProcedure("threads/sendWithRoutines")).toEqual(["model", "memory"]);
    expect(aiDataUsesForProcedure("voice/prepare")).toEqual(["voice"]);
    expect(
      aiDataUsesForProcedure("routines/update", { routineId: "routine", active: false }),
    ).toEqual([]);
    expect(
      aiDataUsesForProcedure("routines/update", { routineId: "routine", active: true }),
    ).toEqual(["model", "memory"]);
    expect(aiConsentTarget({ routineId: "routine-1" })).toEqual({ routineId: "routine-1" });
    expect(aiConsentTarget({ botId: "bot", text: "hello" })).toEqual({ botId: "bot" });
    // A voice request for the account's copy is asked about the account's provider.
    expect(aiConsentTarget({ text: "hello", scope: "account" })).toEqual({
      settingsScope: "account",
    });
    expect(aiConsentTarget({ botId: "bot", scope: "elsewhere" })).toEqual({ botId: "bot" });
    expect(aiConsentTargets({ groupId: "group", routineIds: ["routine-1", "routine-2"] })).toEqual([
      { groupId: "group" },
      { routineId: "routine-1" },
      { routineId: "routine-2" },
    ]);
  });
  it("coalesces concurrent prompts and grants for one account-space recipient", async () => {
    let decide!: (allowed: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const prompt = vi.fn(() => decision);
    const allow = vi.fn(async () => undefined);
    const first = ensureAiDataConsent({
      uses: ["model"],
      status: async () => status,
      prompt,
      allow,
    });
    const second = ensureAiDataConsent({
      uses: ["model"],
      status: async () => status,
      prompt,
      allow,
    });

    await Promise.resolve();
    expect(prompt).toHaveBeenCalledOnce();
    decide(true);
    await Promise.all([first, second]);
    expect(allow).toHaveBeenCalledExactlyOnceWith({
      scope: status.scope,
      version: status.version,
      keys: ["model"],
    });
  });
  it("does not share a pending grant across account-space scopes or recipients", async () => {
    const prompt = vi.fn(async () => true);
    const allow = vi.fn(async () => undefined);
    const statuses = [
      {
        ...status,
        scope: "account-a-space",
        recipients: [status.recipients[0]!],
      },
      {
        ...status,
        scope: "account-b-space",
        recipients: [status.recipients[0]!],
      },
      {
        ...status,
        scope: "account-a-space",
        recipients: [status.recipients[1]!],
      },
    ];

    await Promise.all(
      statuses.map((current) =>
        ensureAiDataConsent({
          uses: ["model", "voice"],
          status: async () => current,
          prompt,
          allow,
        }),
      ),
    );
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(allow).toHaveBeenCalledTimes(3);
  });
  it("does not share a grant across independent API contexts", async () => {
    const prompt = vi.fn(async () => true);
    const allow = vi.fn(async () => undefined);
    await Promise.all([
      ensureAiDataConsent({
        uses: ["model"],
        status: async () => status,
        prompt,
        allow,
        coalesceKey: "https://one.example",
      }),
      ensureAiDataConsent({
        uses: ["model"],
        status: async () => status,
        prompt,
        allow,
        coalesceKey: "https://two.example",
      }),
    ]);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(allow).toHaveBeenCalledTimes(2);
  });
});
