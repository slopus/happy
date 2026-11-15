import type { AdapterContext } from "@rakazo/adapter-kit";
import { canReleaseScreenLease, canTakeScreenLease } from "@rakazo/core";

export const COMPUTER_SCREEN_UNAVAILABLE =
  "The computer screen is temporarily busy. Retry in a moment. File and shell tools still work.";

export class ComputerScreenUnavailableError extends Error {
  constructor(message = COMPUTER_SCREEN_UNAVAILABLE) {
    super(message);
    this.name = "ComputerScreenUnavailableError";
  }
}

/** The browser stopped, but clearing its screen slot failed afterward. */
export class BrowserStoppedReleaseError extends Error {
  constructor(message = "browser stopped") {
    super(message);
    this.name = "BrowserStoppedReleaseError";
  }
}

/** A browser was open again on a profile a save was about to copy, so the save waits. */
export class BrowserStillRunningError extends Error {
  constructor(message = "browser still running") {
    super(message);
    this.name = "BrowserStillRunningError";
  }
}

export function screenSessionKey(context: AdapterContext): string {
  return context.botId ?? "default";
}

export class SingleScreenClaimTracker {
  private readonly owners = new Map<string, { screenKey: string; leaseId?: string }>();

  claim(computerId: string, context: AdapterContext): void {
    const key = screenSessionKey(context);
    const owner = this.owners.get(computerId);
    if (owner && owner.screenKey !== key) {
      throw new ComputerScreenUnavailableError();
    }
    if (owner && !canTakeScreenLease(owner.leaseId, context.screenLeaseId)) {
      if (context.screenLeaseId && owner.leaseId && context.screenLeaseId !== owner.leaseId) {
        throw new ComputerScreenUnavailableError();
      }
    }
    this.owners.set(computerId, {
      screenKey: key,
      leaseId: canTakeScreenLease(owner?.leaseId, context.screenLeaseId)
        ? context.screenLeaseId
        : (owner?.leaseId ?? context.screenLeaseId),
    });
  }

  /** Returns true when this call cleared the in-memory claim. */
  release(computerId: string, context?: AdapterContext): boolean {
    if (!context) {
      this.owners.delete(computerId);
      return true;
    }
    const owner = this.owners.get(computerId);
    if (
      owner?.screenKey === screenSessionKey(context) &&
      canReleaseScreenLease(owner.leaseId, context.screenLeaseId)
    ) {
      this.owners.delete(computerId);
      return true;
    }
    return false;
  }
}

export function isComputerScreenUnavailable(error: unknown): error is Error {
  return (
    error instanceof ComputerScreenUnavailableError ||
    (error instanceof Error && /cannot allocate another screen/i.test(error.message))
  );
}

export function computerScreenUnavailableMessage(error: Error): string {
  if (/cannot allocate another screen/i.test(error.message)) {
    const limit = /\(limit (\d+)\)/i.exec(error.message)?.[1];
    return `All ${limit ? `${limit} ` : ""}Team Computer screens are in use (SANDBOX_TEAM_SCREEN_LIMIT)`;
  }
  return COMPUTER_SCREEN_UNAVAILABLE;
}

export async function withComputerScreenAvailability<T>(
  work: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (error) {
    if (isComputerScreenUnavailable(error))
      return { error: computerScreenUnavailableMessage(error) };
    throw error;
  }
}
