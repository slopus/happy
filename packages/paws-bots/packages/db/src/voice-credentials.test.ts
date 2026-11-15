import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import type { VoiceTarget } from "./voice-credentials.js";
import {
  findDefaultVoiceCredential,
  findVoiceCredential,
  selectVoicePreference,
} from "./voice-credentials.js";

const scope = { userId: "user", spaceId: "space" };
const account: VoiceTarget = { ...scope, scope: "account" };
const space: VoiceTarget = { ...scope, scope: "space" };
const credential = {
  id: "credential",
  userId: "user",
  provider: "elevenlabs",
  secretId: "secret",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function preferenceClient({ overridden = false } = {}) {
  const table = () => ({
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn().mockResolvedValue({ id: "preference" }),
    findFirst: vi.fn().mockResolvedValue(null),
  });
  const userVoicePreference = table();
  const spaceVoicePreference = table();
  const prisma = {
    userVoicePreference,
    spaceVoicePreference,
    spaceSettingOverride: {
      findUnique: vi.fn().mockResolvedValue(overridden ? { setting: "voice" } : null),
    },
    userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaClient;
  return { prisma, userVoicePreference, spaceVoicePreference };
}

describe("selectVoicePreference", () => {
  it("makes the account's connection the default without touching any Space", async () => {
    const { prisma, userVoicePreference, spaceVoicePreference } = preferenceClient();

    await selectVoicePreference(prisma, account, "credential", "voice");

    expect(userVoicePreference.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, credentialId: { not: "credential" }, userId: "user" },
      data: { isDefault: false },
    });
    expect(userVoicePreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_credentialId: { userId: "user", credentialId: "credential" } },
        create: expect.objectContaining({ userId: "user", voiceId: "voice", isDefault: true }),
      }),
    );
    expect(spaceVoicePreference.upsert).not.toHaveBeenCalled();
  });

  it("writes a Space's own copy when the target is the Space", async () => {
    const { prisma, userVoicePreference, spaceVoicePreference } = preferenceClient();

    await selectVoicePreference(prisma, space, "credential", "voice");

    expect(spaceVoicePreference.updateMany).toHaveBeenCalledWith({
      where: {
        isDefault: true,
        credentialId: { not: "credential" },
        userId: "user",
        spaceId: "space",
      },
      data: { isDefault: false },
    });
    expect(spaceVoicePreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: "space",
            userId: "user",
            credentialId: "credential",
          },
        },
      }),
    );
    expect(userVoicePreference.upsert).not.toHaveBeenCalled();
  });

  it("leaves the speech model unchanged when the caller omits it", async () => {
    const { prisma, userVoicePreference } = preferenceClient();

    await selectVoicePreference(prisma, account, "credential", "voice");

    const call = userVoicePreference.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.create.speechModel).toBeUndefined();
    expect(call.update.speechModel).toBeUndefined();
  });

  it("stores or clears a speech model override with the voice", async () => {
    const { prisma, userVoicePreference } = preferenceClient();

    await selectVoicePreference(prisma, account, "credential", "voice", "s1");
    await selectVoicePreference(prisma, account, "credential", "voice", null);

    expect(userVoicePreference.upsert.mock.calls.map(([call]) => call.update)).toEqual([
      { voiceId: "voice", isDefault: true, speechModel: "s1" },
      { voiceId: "voice", isDefault: true, speechModel: null },
    ]);
  });
});

describe("voice that applies", () => {
  it("reads the account's default when the Space follows the account", async () => {
    const { prisma, userVoicePreference, spaceVoicePreference } = preferenceClient();
    userVoicePreference.findFirst.mockResolvedValue({
      credential,
      isDefault: true,
      voiceId: "account-voice",
      speechModel: null,
    });

    await expect(findDefaultVoiceCredential(prisma, scope)).resolves.toMatchObject({
      id: "credential",
      voiceId: "account-voice",
      speechModel: "",
    });
    expect(spaceVoicePreference.findFirst).not.toHaveBeenCalled();
  });

  it("reads the Space's own default when it overrides voice, and ignores it otherwise", async () => {
    const { prisma, userVoicePreference, spaceVoicePreference } = preferenceClient({
      overridden: true,
    });
    spaceVoicePreference.findFirst.mockResolvedValue({
      credential,
      isDefault: true,
      voiceId: "space-voice",
      speechModel: "s1",
    });

    await expect(findDefaultVoiceCredential(prisma, scope)).resolves.toMatchObject({
      voiceId: "space-voice",
      speechModel: "s1",
    });
    expect(spaceVoicePreference.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isDefault: true, userId: "user", spaceId: "space" },
      }),
    );
    expect(userVoicePreference.findFirst).not.toHaveBeenCalled();
  });

  it("reads the account's copy when asked for it, even in an overriding Space", async () => {
    const { prisma, userVoicePreference, spaceVoicePreference } = preferenceClient({
      overridden: true,
    });

    await findVoiceCredential(prisma, scope, "elevenlabs", "account");

    expect(userVoicePreference.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { credential: { provider: "elevenlabs" }, userId: "user" },
      }),
    );
    expect(spaceVoicePreference.findFirst).not.toHaveBeenCalled();
  });
});
