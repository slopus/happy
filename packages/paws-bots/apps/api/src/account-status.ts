import type { PushTokenStore } from "@rakazo/adapters";
import type { DirectoryAccountChange } from "@rakazo/auth";
import type { PrismaClient, SpaceDeparture, ThreadEvents } from "@rakazo/db";
import {
  cancelDeactivatedAccountRuns,
  leaveInvitedSpaces,
  recordSecurityEvent,
  runAsSystem,
} from "@rakazo/db";
import type { DeviceStore } from "./user-devices.js";
import { revokeUserDevices } from "./user-devices.js";

export interface AccountStatusDeps {
  prisma: PrismaClient;
  pushTokens: Pick<PushTokenStore, "remove">;
  devices: DeviceStore;
  events: Pick<ThreadEvents, "notify">;
  /** What follows leaving a Space (as after `afterSpaceDeparture`); never throws. */
  afterDeparture(
    actor: { spaceId: string; userId: string },
    departure: SpaceDeparture,
  ): Promise<void>;
}

/**
 * Finishes a directory change once its SCIM request committed. The account row says what
 * happened: a change in a request that rolled back finds it as before and does nothing.
 */
export async function settleDirectoryChange(
  deps: AccountStatusDeps,
  change: DirectoryAccountChange,
): Promise<void> {
  await runAsSystem("settle a directory account change", async () => {
    const user = await deps.prisma.user.findUnique({
      where: { id: change.userId },
      select: { deactivatedAt: true },
    });
    if (!user || change.active === Boolean(user.deactivatedAt)) return;
    await finishStatusChange(deps, change.userId, change.active, change.changed, "directory");
  });
}

/**
 * The operator turns an account off or back on. Deactivating an account that already is off
 * still finishes ending its access. While directory provisioning is on, the identity provider
 * owns the accounts it provisions: one it has on is turned off there, and one it turned off or
 * deleted is turned back on there. Either refusal is `"directory"`. With provisioning off, no
 * provider can reach them, so the operator decides.
 */
export async function setAccountActive(
  deps: AccountStatusDeps,
  userId: string,
  active: boolean,
  directoryProvisioning: boolean,
): Promise<"changed" | "unchanged" | "directory"> {
  return runAsSystem("change an account's status", async () => {
    if (directoryProvisioning) {
      const [links, deleted] = await Promise.all([
        deps.prisma.scimUser.findMany({ where: { userId }, select: { active: true } }),
        deps.prisma.scimIdentityTombstone.count({ where: { userId } }),
      ]);
      // The directory has it on, so its next update would undo turning it off here; or the
      // directory turned it off or deleted it (a tombstone) and has not added it back.
      const on = links.some((link) => link.active);
      if (on ? !active : active && links.length + deleted > 0) return "directory";
    }
    const { count } = await deps.prisma.user.updateMany({
      where: { id: userId, deactivatedAt: active ? { not: null } : null },
      data: { deactivatedAt: active ? null : new Date() },
    });
    await finishStatusChange(deps, userId, active, count > 0, "operator");
    return count ? "changed" : "unchanged";
  });
}

/**
 * Records a real change first, so a failed cleanup can be retried as no change. Ending a
 * deactivated account's access is repeatable. No sign-in is admitted while an account is off,
 * so any session left at reactivation slipped in around the deactivation; it goes rather than
 * come back to life.
 */
async function finishStatusChange(
  deps: AccountStatusDeps,
  userId: string,
  active: boolean,
  changed: boolean,
  by: "directory" | "operator",
) {
  if (changed)
    await recordSecurityEvent({
      type: active ? "auth.account.reactivated" : "auth.account.deactivated",
      userId,
      metadata: { by },
    });
  if (!active) await endDeactivatedAccess(deps, userId);
  else if (changed) await deps.prisma.session.deleteMany({ where: { userId } });
}

/**
 * Ends what a deactivated account had going: sign-ins, paired computers, notification
 * registrations, views of its bots' screens, runs, and membership of other people's Spaces. Its
 * own bots, chats, memory, files and connections stay. Sign-in and new runs are refused separately for as long as the account
 * stays deactivated. Every step is tried even when an earlier one fails, and running it again
 * is safe; the operator's `account-status.js deactivate` does.
 */
export async function endDeactivatedAccess(deps: AccountStatusDeps, userId: string) {
  const { prisma } = deps;
  const steps: Array<() => Promise<unknown>> = [
    () => prisma.session.deleteMany({ where: { userId } }),
    () => revokeUserDevices(deps.devices, userId),
    () => deps.pushTokens.remove(userId),
    () => prisma.callPushDevice.deleteMany({ where: { userId } }),
    // A pending code would otherwise link a chat app to the account after this.
    () => prisma.messagingLinkCode.deleteMany({ where: { userId } }),
    // Screen links issued before now stop working; people still allowed get new ones.
    () =>
      prisma.bot.updateMany({ where: { userId }, data: { screenGeneration: { increment: 1 } } }),
    // Other people's Spaces keep what the account made there, handed to each Space's owner;
    // Spaces it owns stay its own.
    // Before the account-wide cancel, so each departure stops its own runs there and starts
    // the teammates' follow-ups that waited behind them.
    () =>
      leaveInvitedSpaces(
        prisma,
        userId,
        (departure) => deps.afterDeparture({ spaceId: departure.spaceId, userId }, departure),
        { deactivated: true },
      ),
    () => cancelDeactivatedAccountRuns(prisma, deps.events, userId),
  ];
  const failures: unknown[] = [];
  for (const step of steps)
    await (async () => step())().catch((error: unknown) => failures.push(error));
  if (failures.length)
    throw new AggregateError(failures, "Could not finish ending a deactivated account's access");
}
