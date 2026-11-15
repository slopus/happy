import type { SettingsScope, SpaceSetting } from "@rakazo/contracts";
import { SpaceSettingSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = { userId: string; spaceId: string };
type OverrideClient = Pick<PrismaClient, "spaceSettingOverride">;
type CopyClient = Pick<
  PrismaClient,
  | "spaceSettingOverride"
  | "spaceModelRoleChoice"
  | "userModelRoleChoice"
  | "spaceVoicePreference"
  | "userVoicePreference"
  | "actionApprovalRule"
  | "userActionApprovalRule"
  | "actionAutoReviewPreference"
  | "userActionAutoReviewPreference"
  | "vaultCredential"
>;

/** The settings this Space replaces with its own for the member. */
export async function spaceSettingOverrides(
  prisma: OverrideClient,
  scope: Scope,
): Promise<SpaceSetting[]> {
  const rows = await prisma.spaceSettingOverride.findMany({
    where: { spaceId: scope.spaceId, userId: scope.userId },
    select: { setting: true },
  });
  const saved = new Set(rows.map((row) => row.setting));
  return SpaceSettingSchema.options.filter((setting) => saved.has(setting));
}

/**
 * The copy a settings call acts on. An explicit scope wins; otherwise the Space's override
 * when it has one, else the account's, so apps that predate overrides keep working.
 */
export async function settingsTarget(
  prisma: OverrideClient,
  scope: Scope,
  setting: SpaceSetting,
  requested?: SettingsScope,
): Promise<SettingsScope> {
  if (requested) return requested;
  const row = await prisma.spaceSettingOverride.findUnique({
    where: { spaceId_userId_setting: { spaceId: scope.spaceId, userId: scope.userId, setting } },
    select: { setting: true },
  });
  return row ? "space" : "account";
}

/**
 * Locks the member's place in the Space for the rest of the caller's transaction. Starting or
 * ending an override takes it, and so does every settings write before it picks a copy, so a
 * write never lands in the copy an override change just replaced.
 */
export async function lockSpaceSettings(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  scope: Scope,
): Promise<void> {
  const members = await tx.$queryRaw<Array<{ locked: number }>>`
    SELECT 1 AS locked FROM "space_members" WHERE "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR UPDATE
  `;
  if (members.length !== 1) throw new Error("Space membership not found");
}

/**
 * Starts or ends a Space's override. Starting copies the account's settings so the Space
 * begins where the member already is; ending drops the Space's copy so nothing stale stays.
 * Credentials are the exception: a Space's own vault starts empty, so it holds only what was
 * saved for it, and ending the override deletes those credentials.
 */
export async function setSpaceSettingOverride(
  prisma: PrismaClient,
  scope: Scope,
  setting: SpaceSetting,
  enabled: boolean,
): Promise<SpaceSetting[]> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceSettings(tx, scope);
        const key = {
          spaceId_userId_setting: { spaceId: scope.spaceId, userId: scope.userId, setting },
        };
        const existing = await tx.spaceSettingOverride.findUnique({ where: key });
        if (enabled === Boolean(existing)) return spaceSettingOverrides(tx, scope);
        await clearSpaceCopy(tx, scope, setting);
        if (enabled) {
          await copyAccountIntoSpace(tx, scope, setting);
          await tx.spaceSettingOverride.create({
            data: { spaceId: scope.spaceId, userId: scope.userId, setting },
          });
        } else {
          await tx.spaceSettingOverride.delete({ where: key });
        }
        return spaceSettingOverrides(tx, scope);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function clearSpaceCopy(tx: CopyClient, scope: Scope, setting: SpaceSetting) {
  const member = { spaceId: scope.spaceId, userId: scope.userId };
  if (setting === "models") {
    await tx.spaceModelRoleChoice.deleteMany({ where: member });
  } else if (setting === "voice") {
    await tx.spaceVoicePreference.deleteMany({ where: member });
  } else if (setting === "credentials") {
    await tx.vaultCredential.deleteMany({ where: member });
  } else {
    await tx.actionApprovalRule.deleteMany({
      where: { spaceId: scope.spaceId, createdByUserId: scope.userId },
    });
    await tx.actionAutoReviewPreference.deleteMany({ where: member });
  }
}

async function copyAccountIntoSpace(tx: CopyClient, scope: Scope, setting: SpaceSetting) {
  if (setting === "credentials") return;
  const member = { spaceId: scope.spaceId, userId: scope.userId };
  if (setting === "models") {
    const rows = await tx.userModelRoleChoice.findMany({ where: { userId: scope.userId } });
    if (rows.length) {
      await tx.spaceModelRoleChoice.createMany({
        data: rows.map(({ userId: _userId, ...row }) => ({ ...row, ...member })),
      });
    }
  } else if (setting === "voice") {
    const rows = await tx.userVoicePreference.findMany({ where: { userId: scope.userId } });
    if (rows.length) {
      await tx.spaceVoicePreference.createMany({
        data: rows.map((row) => ({
          ...member,
          credentialId: row.credentialId,
          voiceId: row.voiceId,
          speechModel: row.speechModel,
          isDefault: row.isDefault,
        })),
      });
    }
  } else {
    const [rules, autoReview] = await Promise.all([
      tx.userActionApprovalRule.findMany({ where: { userId: scope.userId } }),
      tx.userActionAutoReviewPreference.findUnique({ where: { userId: scope.userId } }),
    ]);
    if (rules.length) {
      await tx.actionApprovalRule.createMany({
        data: rules.map((rule) => ({
          spaceId: scope.spaceId,
          createdByUserId: scope.userId,
          effect: rule.effect,
          matchKind: rule.matchKind,
          matchValue: rule.matchValue,
        })),
      });
    }
    if (autoReview) {
      await tx.actionAutoReviewPreference.create({
        data: { ...member, enabled: autoReview.enabled, skipApprovals: autoReview.skipApprovals },
      });
    }
  }
}
