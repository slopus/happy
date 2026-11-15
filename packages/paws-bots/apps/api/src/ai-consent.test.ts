import type { Actor } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./thread-target.js", () => ({
  resolveThreadTarget: async () => ({ kind: "bot", botId: "bot" }),
}));

import { aiConsentStatus, allowAiConsent } from "./ai-consent.js";
import type { RouterDeps } from "./router.js";

function setup() {
  const upsert = vi.fn(async () => ({}));
  const deps = {
    env: { agentRuntime: "scripted" },
    prisma: {
      userModelPreference: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userModelRoleChoice: { findMany: vi.fn(async () => []) },
      spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
      userModelCredential: { findMany: vi.fn(async () => []) },
      secret: { findMany: vi.fn(async () => []) },
      bot: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      userVoicePreference: {
        findFirst: vi.fn(async () => ({ credential: { provider: "openai" }, voiceId: "alloy" })),
        findMany: vi.fn(async () => [{ credential: { provider: "openai" } }]),
      },
      spaceMemoryConfig: { findUnique: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      aiDataConsent: { findMany: vi.fn(async () => []), upsert },
      $transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) =>
        write({ aiDataConsent: { upsert } }),
      ),
    },
  } as unknown as RouterDeps;
  return { deps, upsert, actor: { userId: "user", spaceId: "space" } as Actor };
}
describe("consent grants", () => {
  it("includes reachable helper models and cloud services for a targeted send", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    deps.cloudAgent = {
      key: "test",
      spaceId: actor.spaceId,
      provider: { describe: () => ({ id: "cursor", capabilities: { offline: false } }) },
    } as RouterDeps["cloudAgent"];
    vi.mocked(deps.prisma.userModelPreference.findMany).mockResolvedValue([
      {
        modelId: "helper-model",
        credential: { provider: "anthropic", secretId: "test-secret" },
      },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    expect(status.recipients.map((recipient) => recipient.name)).toEqual(
      expect.arrayContaining(["Anthropic", "Cursor"]),
    );
    expect(deps.prisma.userVoicePreference.findMany).not.toHaveBeenCalled();
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["bot"] } }) }),
    );
    expect(deps.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: { in: ["bot"] },
          OR: [{ active: true }],
        }),
      }),
    );
  });
  it("discloses the user's connected environment and asks again when it moves", async () => {
    const { deps, actor } = setup();
    deps.cloudAgent = {
      key: "test",
      spaceId: actor.spaceId,
      provider: { describe: () => ({ id: "cursor", capabilities: { offline: false } }) },
    } as RouterDeps["cloudAgent"];
    const forActor = vi.fn();
    deps.userCloudAgents = {
      forActor,
      listForActor: async () => [],
    } as unknown as RouterDeps["userCloudAgents"];
    const recipients = async (baseUrl: string) => {
      forActor.mockResolvedValue({
        key: "mcp:server",
        spaceId: actor.spaceId,
        baseUrl,
        provider: { describe: () => ({ id: "t3code", capabilities: { offline: false } }) },
      });
      return (await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] })).recipients;
    };
    const first = await recipients("https://t3.example.test/mcp");
    // Only an environment the target agent may use is disclosed for it.
    expect(forActor).toHaveBeenCalledWith({
      spaceId: actor.spaceId,
      userId: actor.userId,
      botIds: ["bot"],
    });
    // The agent's work goes to the user's own environment, and to the deployment's provider
    // once that environment's approval runs out.
    expect(first.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["T3 Code (https://t3.example.test)", "Cursor"]),
    );
    const key = first.find((entry) => entry.name.startsWith("T3 Code"))!.key;
    const moved = await recipients("https://t3-2.example.test/mcp");
    expect(moved.find((entry) => entry.name.startsWith("T3 Code"))!.key).not.toBe(key);
  });
  it("allows what an agent's own check showed, wherever its work goes", async () => {
    const { deps, actor, upsert } = setup();
    const connection = (key: string, id: string, baseUrl?: string) => ({
      key,
      spaceId: actor.spaceId,
      baseUrl,
      provider: { describe: () => ({ id, capabilities: { offline: false } }) },
    });
    deps.cloudAgent = connection("deployment", "cursor") as RouterDeps["cloudAgent"];
    const t3 = connection("mcp:one", "t3code", "https://one.example.test/mcp");
    const other = connection("mcp:two", "t3code", "https://two.example.test/mcp");
    // The target agent first has neither environment, so its work goes to the deployment, then
    // only the second one; any agent's first choice is the first environment.
    let assigned: typeof t3 | null = null;
    deps.userCloudAgents = {
      forActor: async ({ botIds }: { botIds?: string[] }) => (botIds ? assigned : t3),
      listForActor: async () => [t3, other],
    } as unknown as RouterDeps["userCloudAgents"];
    for (const name of ["Cursor", "T3 Code (https://two.example.test)"]) {
      if (name !== "Cursor") assigned = other;
      const shown = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
      const recipient = shown.recipients.find((entry) => entry.name === name)!;
      // The client allows without the target, as mobile does.
      await allowAiConsent(deps, actor, {
        scope: shown.scope,
        version: shown.version,
        keys: [recipient.key],
      });
    }
    expect(upsert).toHaveBeenCalledTimes(2);
  });
  it("includes an inactive routine only when the check is for that routine", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    await aiConsentStatus(deps, actor, { routineId: "routine-1", uses: ["model"] });
    expect(deps.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ active: true }, { id: "routine-1" }],
        }),
      }),
    );
  });
  it("includes every purpose's selected models in the provider-sharing disclosure until each is allowed", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.userModelRoleChoice.findMany).mockResolvedValue([
      {
        role: "main",
        position: 1,
        provider: "anthropic",
        modelId: "claude-backup",
        thinkingLevel: null,
      },
    ] as never);
    vi.mocked(deps.prisma.userModelCredential.findMany).mockResolvedValue([
      {
        id: "backup-credential",
        userId: actor.userId,
        provider: "anthropic",
        label: "fixture",
        secretId: "backup-secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ] as never);

    const status = await aiConsentStatus(deps, actor, { uses: ["model"] });

    expect(status.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Anthropic",
          detail: "claude-backup",
          use: "model",
          allowed: false,
        }),
      ]),
    );
    expect(deps.prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: actor.userId },
        orderBy: [{ role: "asc" }, { position: "asc" }],
      }),
    );
    expect(deps.prisma.spaceModelRoleChoice.findMany).not.toHaveBeenCalled();
  });
  it("discloses a Space's own models instead of the account's when it overrides them", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
      setting: "models",
    } as never);
    await aiConsentStatus(deps, actor, { uses: ["model"] });
    expect(deps.prisma.spaceModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: actor.userId, spaceId: actor.spaceId } }),
    );
    expect(deps.prisma.userModelRoleChoice.findMany).not.toHaveBeenCalled();
  });
  it("discloses only the selected voice provider before a voice action", async () => {
    const { deps, actor } = setup();
    vi.mocked(deps.prisma.userVoicePreference.findMany).mockResolvedValue([
      { credential: { provider: "openai" } },
      { credential: { provider: "elevenlabs" } },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { uses: ["voice"] });
    expect(status.recipients).toHaveLength(1);
    expect(status.recipients[0]?.name).toBe("OpenAI");
    expect(deps.prisma.userVoicePreference.findMany).not.toHaveBeenCalled();
  });
  it("returns an operator policy without requiring a hosted provider", async () => {
    const { deps, actor } = setup();
    deps.env.privacyPolicyUrl = "https://example.com/privacy";
    expect((await aiConsentStatus(deps, actor)).privacyUrl).toBe("https://example.com/privacy");
  });
  it("rejects stale disclosures, unknown recipients, and a changed account or Space", async () => {
    const { deps, actor, upsert } = setup();
    const current = await aiConsentStatus(deps, actor);
    const input = {
      scope: current.scope,
      version: current.version,
      keys: [current.recipients[0]!.key],
    };
    for (const invalid of [
      { ...input, version: "old" },
      { ...input, scope: "different-account" },
      { ...input, keys: ["unknown"] },
    ]) {
      await expect(allowAiConsent(deps, actor, invalid)).rejects.toThrow("changed");
    }
    expect(upsert).not.toHaveBeenCalled();
    await allowAiConsent(deps, actor, input);
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey: input.keys[0],
          version: AI_DISCLOSURE_VERSION,
        },
      }),
    );
  });
});

it("discloses the self-hosted voice origin without its encrypted key", async () => {
  const { deps, actor } = setup();
  vi.mocked(deps.prisma.userVoicePreference.findFirst).mockResolvedValue({
    credential: { provider: "openai-compatible", secretId: "voice-secret" },
    voiceId: "af_heart",
  } as never);
  deps.prisma.secret.findFirst = vi
    .fn()
    .mockResolvedValue({ id: "voice-secret", ciphertext: "encrypted-fixture" });
  deps.secrets = {
    load: vi.fn().mockResolvedValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://100.64.0.10:8810/v1",
        apiKey: "local-test-key",
        ttsModel: "kokoro",
        sttModel: "whisper-1",
      }),
    ),
    put: vi.fn(),
  } as never;
  const status = await aiConsentStatus(deps, actor, { uses: ["voice"] });
  expect(status.recipients).toHaveLength(1);
  expect(JSON.stringify(status)).toContain("http://100.64.0.10:8810");
  expect(JSON.stringify(status)).not.toContain("local-test-key");
  expect(JSON.stringify(status)).not.toContain("apiKey");
});

it("discloses the Space's own voices where it overrides voice", async () => {
  const { deps, actor } = setup();
  Object.assign(deps.prisma, {
    spaceVoicePreference: {
      findMany: vi.fn(async () => [{ credential: { provider: "elevenlabs" } }]),
    },
  });
  vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
    setting: "voice",
  } as never);
  const status = await aiConsentStatus(deps, actor);
  expect(status.recipients.map((recipient) => recipient.name)).toEqual(["ElevenLabs"]);
  expect(deps.prisma.userVoicePreference.findMany).not.toHaveBeenCalled();
});

it("asks about the account's voice provider when a voice action names the account copy", async () => {
  const { deps, actor } = setup();
  Object.assign(deps.prisma, {
    spaceVoicePreference: {
      findFirst: vi.fn(async () => ({ credential: { provider: "elevenlabs" }, voiceId: "space" })),
    },
  });
  vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
    setting: "voice",
  } as never);
  const applied = await aiConsentStatus(deps, actor, { uses: ["voice"] });
  expect(applied.recipients.map((recipient) => recipient.name)).toEqual(["ElevenLabs"]);
  const account = await aiConsentStatus(deps, actor, {
    uses: ["voice"],
    settingsScope: "account",
  });
  expect(account.recipients.map((recipient) => recipient.name)).toEqual(["OpenAI"]);
});

it("grants the account's voice provider when the grant names the account copy", async () => {
  const { deps, actor, upsert } = setup();
  Object.assign(deps.prisma, {
    spaceVoicePreference: {
      findMany: vi.fn(async () => [{ credential: { provider: "elevenlabs" } }]),
    },
  });
  vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
    setting: "voice",
  } as never);
  const reviewed = await aiConsentStatus(deps, actor, {
    uses: ["voice"],
    settingsScope: "account",
  });
  const keys = reviewed.recipients.map((recipient) => recipient.key);
  await expect(
    allowAiConsent(deps, actor, { scope: reviewed.scope, version: reviewed.version, keys }),
  ).rejects.toThrow("AI data sharing changed");
  await allowAiConsent(deps, actor, {
    scope: reviewed.scope,
    version: reviewed.version,
    keys,
    settingsScope: "account",
  });
  expect(upsert).toHaveBeenCalled();
});
