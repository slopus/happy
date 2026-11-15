import type {
  ModelRole,
  ModelRoleChoice,
  ModelRoleSettings,
  SettingsScope,
} from "@rakazo/contracts";
import {
  backupChoiceKey,
  canonicalPiProviderId,
  modelRoleChoiceKey,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { lockSpaceSettings, settingsTarget } from "./space-settings.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = { userId: string; spaceId: string };
/** Which copy of a member's model roles a call acts on: the account's or the Space's override. */
export type ModelRoleTarget = Scope & { scope: SettingsScope };
type RoleClient = Pick<PrismaClient, "spaceModelRoleChoice" | "userModelRoleChoice">;
type StoredChoice = {
  role: string;
  position: number;
  provider: string;
  modelId: string;
  thinkingLevel: string | null;
  credentialId: string | null;
};
type RoleOwner = { userId: string; spaceId?: string };
/** The columns both copies share; the Space's rows are also keyed by its id. */
type RoleRows = {
  findMany(args: {
    where: RoleOwner & { role?: string };
    orderBy: Array<{ role: "asc" } | { position: "asc" }>;
    select: Record<keyof StoredChoice, true>;
  }): Promise<StoredChoice[]>;
  deleteMany(args: { where: RoleOwner & { role: string } }): Promise<unknown>;
  createMany(args: { data: Array<StoredChoice & RoleOwner> }): Promise<unknown>;
};
const storedChoice = {
  role: true,
  position: true,
  provider: true,
  modelId: true,
  thinkingLevel: true,
  credentialId: true,
} as const;

function roleChoice(row: StoredChoice): ModelRoleChoice {
  const thinkingLevel = ThinkingLevelSchema.safeParse(row.thinkingLevel);
  return {
    provider: row.provider,
    modelId: row.modelId,
    ...(thinkingLevel.success ? { thinkingLevel: thinkingLevel.data } : {}),
    ...(row.credentialId ? { credentialId: row.credentialId } : {}),
  };
}

function roleRows(prisma: RoleClient, target: ModelRoleTarget) {
  return target.scope === "space"
    ? {
        table: prisma.spaceModelRoleChoice as unknown as RoleRows,
        owner: { userId: target.userId, spaceId: target.spaceId },
      }
    : {
        table: prisma.userModelRoleChoice as unknown as RoleRows,
        owner: { userId: target.userId },
      };
}

/**
 * The copy of the member's models a call acts on: the one `requested` names, else the
 * Space's own when it overrides them, else the account's.
 */
export async function modelRoleTarget(
  prisma: Pick<PrismaClient, "spaceSettingOverride">,
  scope: Scope,
  requested?: SettingsScope,
): Promise<ModelRoleTarget> {
  return {
    userId: scope.userId,
    spaceId: scope.spaceId,
    scope: await settingsTarget(prisma, scope, "models", requested),
  };
}

/** The member's ordered models for a purpose as they apply in the Space, or in `requested`. */
export async function appliedModelRole(
  prisma: RoleClient & Pick<PrismaClient, "spaceSettingOverride">,
  scope: Scope,
  role: ModelRole,
  requested?: SettingsScope,
): Promise<ModelRoleSettings> {
  return getModelRole(prisma, await modelRoleTarget(prisma, scope, requested), role);
}

/** The member's own ordered models for a purpose; empty when the deployment's defaults apply. */
export async function getModelRole(
  prisma: RoleClient,
  target: ModelRoleTarget,
  role: ModelRole,
): Promise<ModelRoleSettings> {
  const { table, owner } = roleRows(prisma, target);
  const rows = await table.findMany({
    where: { ...owner, role },
    orderBy: [{ position: "asc" }],
    select: storedChoice,
  });
  const primary = rows.find((row) => row.position === 0);
  return {
    primary: primary ? roleChoice(primary) : null,
    backups: rows.filter((row) => row.position > 0).map(roleChoice),
  };
}

/** Every purpose's models in one copy, each purpose's in order. */
export async function listModelRoleChoices(
  prisma: RoleClient,
  target: ModelRoleTarget,
): Promise<Array<ModelRoleChoice & { role: string; position: number }>> {
  const { table, owner } = roleRows(prisma, target);
  const rows = await table.findMany({
    where: owner,
    orderBy: [{ role: "asc" }, { position: "asc" }],
    select: storedChoice,
  });
  return rows.map((row) => ({ ...roleChoice(row), role: row.role, position: row.position }));
}

/**
 * Saves a purpose's list to the copy `target.scope` names, or, when it names none, to the
 * copy that applies in the Space at the moment of the save.
 */
export async function updateModelRole(
  prisma: PrismaClient,
  target: Scope & { scope?: SettingsScope },
  role: ModelRole,
  patch: Partial<ModelRoleSettings>,
): Promise<ModelRoleSettings> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceSettings(tx, target);
        const resolved = await modelRoleTarget(
          tx,
          { userId: target.userId, spaceId: target.spaceId },
          target.scope,
        );
        // The account's list is shared by every Space, so its saves also queue on the user.
        // At ReadCommitted, the rewrite after these locks observes the previous writer's list.
        if (resolved.scope === "account") {
          const users = await tx.$queryRaw<Array<{ locked: number }>>`
            SELECT 1 AS locked FROM "user" WHERE "id" = ${target.userId} FOR UPDATE
          `;
          if (users.length !== 1) throw new Error("Model settings owner not found");
        }
        return writeModelRole(tx, resolved, role, patch);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ),
  );
}

/**
 * Rewrites a purpose's ordered list inside the caller's transaction. A choice without a
 * thinking level keeps the one its model already had, so reordering never resets effort.
 */
export async function writeModelRole(
  tx: RoleClient,
  target: ModelRoleTarget,
  role: ModelRole,
  patch: Partial<ModelRoleSettings>,
): Promise<ModelRoleSettings> {
  const { table, owner } = roleRows(tx, target);
  const current = await getModelRole(tx, target, role);
  const saved = [...(current.primary ? [current.primary] : []), ...current.backups];
  // The same row first, then the same model on another connection.
  const savedThinking = (choice: ModelRoleChoice) =>
    (
      saved.find((item) => modelRoleChoiceKey(item) === modelRoleChoiceKey(choice)) ??
      saved.find((item) => backupChoiceKey(item) === backupChoiceKey(choice))
    )?.thinkingLevel ?? null;
  // Apps that predate connections send rows without one; a row keeps the connection its
  // model already ran on when only one connection did.
  const savedConnection = (choice: ModelRoleChoice) => {
    const owners = saved.filter((item) => backupChoiceKey(item) === backupChoiceKey(choice));
    return owners.length === 1 ? owners[0]!.credentialId : undefined;
  };
  const withThinking = (choice: ModelRoleChoice): ModelRoleChoice => {
    const credentialId =
      choice.credentialId !== undefined ? choice.credentialId : savedConnection(choice);
    return {
      ...choice,
      provider: canonicalPiProviderId(choice.provider),
      ...(credentialId ? { credentialId } : {}),
      thinkingLevel:
        choice.thinkingLevel !== undefined ? choice.thinkingLevel : savedThinking(choice),
    };
  };
  const primary =
    patch.primary === undefined ? current.primary : patch.primary && withThinking(patch.primary);
  // The primary already runs first, so a matching fallback would never be tried.
  const backups = (patch.backups ?? current.backups)
    .map(withThinking)
    .filter(
      (backup, index, list) =>
        (!primary || modelRoleChoiceKey(backup) !== modelRoleChoiceKey(primary)) &&
        list.findIndex((item) => modelRoleChoiceKey(item) === modelRoleChoiceKey(backup)) === index,
    );
  await table.deleteMany({ where: { ...owner, role } });
  await table.createMany({
    data: [
      ...(primary ? [{ ...primary, position: 0 }] : []),
      ...backups.map((backup, index) => ({ ...backup, position: index + 1 })),
    ].map((row) => ({
      ...owner,
      role,
      position: row.position,
      provider: row.provider,
      modelId: row.modelId,
      thinkingLevel: row.thinkingLevel ?? null,
      credentialId: row.credentialId ?? null,
    })),
  });
  return getModelRole(tx, target, role);
}
