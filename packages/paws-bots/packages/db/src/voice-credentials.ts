import type { SettingsScope } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { newestCredentialOrder } from "./model-credentials.js";
import { settingsTarget } from "./space-settings.js";

export const newestVoiceCredentialOrder = newestCredentialOrder;

type VoiceCredentialScope = { userId: string; spaceId: string };

/** The voice copy a call acts on: the account's, or the Space's override. */
export type VoiceTarget = VoiceCredentialScope & { scope: SettingsScope };

type VoicePreferenceClient = Pick<PrismaClient, "spaceVoicePreference" | "userVoicePreference">;
type VoiceReadClient = VoicePreferenceClient &
  Pick<PrismaClient, "spaceSettingOverride" | "userVoiceCredential">;

/** The copy that applies in the Space, unless the caller names one. */
export async function voicePreferenceTarget(
  prisma: Pick<PrismaClient, "spaceSettingOverride">,
  scope: VoiceCredentialScope,
  requested?: SettingsScope,
): Promise<VoiceTarget> {
  const { userId, spaceId } = scope;
  return { userId, spaceId, scope: await settingsTarget(prisma, scope, "voice", requested) };
}

type PreferenceFilter = { isDefault?: boolean; credential?: { provider: string } };

function findPreferenceWithCredential(
  prisma: VoicePreferenceClient,
  target: VoiceTarget,
  where: PreferenceFilter,
) {
  const include = { credential: true } as const;
  const orderBy = [
    { isDefault: "desc" as const },
    { updatedAt: "desc" as const },
    { credentialId: "desc" as const },
  ];
  return target.scope === "account"
    ? prisma.userVoicePreference.findFirst({
        where: { ...where, userId: target.userId },
        include,
        orderBy,
      })
    : prisma.spaceVoicePreference.findFirst({
        where: { ...where, userId: target.userId, spaceId: target.spaceId },
        include,
        orderBy,
      });
}

export function listVoicePreferences(prisma: VoicePreferenceClient, target: VoiceTarget) {
  const include = { credential: true } as const;
  return target.scope === "account"
    ? prisma.userVoicePreference.findMany({ where: { userId: target.userId }, include })
    : prisma.spaceVoicePreference.findMany({
        where: { userId: target.userId, spaceId: target.spaceId },
        include,
      });
}

export function findVoicePreference(
  prisma: VoicePreferenceClient,
  target: VoiceTarget,
  credentialId: string,
) {
  return target.scope === "account"
    ? prisma.userVoicePreference.findUnique({
        where: { userId_credentialId: { userId: target.userId, credentialId } },
      })
    : prisma.spaceVoicePreference.findUnique({
        where: {
          spaceId_userId_credentialId: {
            spaceId: target.spaceId,
            userId: target.userId,
            credentialId,
          },
        },
      });
}

/**
 * Saves a connection's choice in the copy; omitted fields keep what is saved. `isDefault`
 * also takes the default from the copy's other connections, so speak and transcribe use it.
 */
export async function saveVoicePreference(
  prisma: VoicePreferenceClient,
  target: VoiceTarget,
  credentialId: string,
  data: { voiceId?: string; speechModel?: string | null; isDefault?: true },
) {
  if (data.isDefault) {
    const others = { isDefault: true, credentialId: { not: credentialId } };
    if (target.scope === "account") {
      await prisma.userVoicePreference.updateMany({
        where: { ...others, userId: target.userId },
        data: { isDefault: false },
      });
    } else {
      await prisma.spaceVoicePreference.updateMany({
        where: { ...others, userId: target.userId, spaceId: target.spaceId },
        data: { isDefault: false },
      });
    }
  }
  return target.scope === "account"
    ? prisma.userVoicePreference.upsert({
        where: { userId_credentialId: { userId: target.userId, credentialId } },
        create: { userId: target.userId, credentialId, ...data },
        update: data,
      })
    : prisma.spaceVoicePreference.upsert({
        where: {
          spaceId_userId_credentialId: {
            spaceId: target.spaceId,
            userId: target.userId,
            credentialId,
          },
        },
        create: { spaceId: target.spaceId, userId: target.userId, credentialId, ...data },
        update: data,
      });
}

/** Makes a connection and voice the copy's default. Omitted speechModel keeps the saved one. */
export function selectVoicePreference(
  prisma: VoicePreferenceClient,
  target: VoiceTarget,
  credentialId: string,
  voiceId: string,
  speechModel?: string | null,
) {
  return saveVoicePreference(prisma, target, credentialId, {
    voiceId,
    speechModel,
    isDefault: true,
  });
}

function withVoicePreference<
  T extends {
    credential: {
      id: string;
      userId: string;
      provider: string;
      secretId: string;
      createdAt: Date;
      updatedAt: Date;
    };
    isDefault: boolean;
    voiceId: string;
    speechModel: string | null;
  },
>(preference: T) {
  return {
    ...preference.credential,
    isDefault: preference.isDefault,
    voiceId: preference.voiceId,
    speechModel: preference.speechModel ?? "",
  };
}

/** The default voice connection in the copy that applies, or in the one requested. */
export async function findDefaultVoiceCredential(
  prisma: VoiceReadClient,
  scope: VoiceCredentialScope,
  requested?: SettingsScope,
) {
  const target = await voicePreferenceTarget(prisma, scope, requested);
  const preference = await findPreferenceWithCredential(prisma, target, { isDefault: true });
  return preference ? withVoicePreference(preference) : null;
}

export function findNewestUserVoiceCredential(
  prisma: Pick<PrismaClient, "userVoiceCredential">,
  userId: string,
  provider: string,
) {
  return prisma.userVoiceCredential.findFirst({
    where: { userId, provider },
    orderBy: newestVoiceCredentialOrder,
  });
}

/** A provider's connection with its choice in the copy that applies, or the one requested. */
export async function findVoiceCredential(
  prisma: VoiceReadClient,
  scope: VoiceCredentialScope,
  provider: string,
  requested?: SettingsScope,
) {
  const target = await voicePreferenceTarget(prisma, scope, requested);
  const preference = await findPreferenceWithCredential(prisma, target, {
    credential: { provider },
  });
  if (preference) return withVoicePreference(preference);
  const credential = await findNewestUserVoiceCredential(prisma, scope.userId, provider);
  return credential ? { ...credential, isDefault: false, voiceId: "", speechModel: "" } : null;
}
