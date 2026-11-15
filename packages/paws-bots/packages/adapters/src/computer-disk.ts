import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { usesNativeShell } from "./native-shell.js";

const MEASURE_TIMEOUT_MS = 5_000;
/** How full the disk is before the bot is told at the start of a run. */
export const DISK_NOTE_PERCENT = 85;
/** How full the disk is before the user sees a warning on the computer. */
export const DISK_WARNING_PERCENT = 90;

export interface ComputerDisk {
  diskUsedBytes: bigint;
  diskFreeBytes: bigint;
}
type StoredDisk = { diskUsedBytes?: bigint | null; diskFreeBytes?: bigint | null };

/** The home filesystem's use, or undefined where the computer is the user's own or cannot say. */
export async function measureComputerDisk(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<ComputerDisk | undefined> {
  if (usesNativeShell(computer.kind) || computer.kind === "none") return undefined;
  let stdout = "";
  let exitCode: number | undefined;
  try {
    for await (const event of sandbox.execute(
      computer,
      { argv: ["df", "-Pk", "."], cwd: ".", timeoutMs: MEASURE_TIMEOUT_MS },
      {
        ...context,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(MEASURE_TIMEOUT_MS)]),
      },
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") exitCode = event.code;
    }
  } catch {
    return undefined;
  }
  return exitCode === 0 ? parseDf(stdout) : undefined;
}

/** `df -Pk` prints a header and one line whose third and fourth fields are used and free KiB. */
export function parseDf(output: string): ComputerDisk | undefined {
  const fields = output.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const [used, free] = [fields.at(-4), fields.at(-3)];
  if (fields.length < 6 || !/^\d+$/.test(used ?? "") || !/^\d+$/.test(free ?? "")) return undefined;
  return { diskUsedBytes: BigInt(used!) * 1024n, diskFreeBytes: BigInt(free!) * 1024n };
}

/** A measurement to store; once the disk has room again, a hidden warning can return. */
export function diskUpdate(disk: ComputerDisk) {
  const percent = diskUsedPercent(disk);
  return percent !== null && percent < DISK_WARNING_PERCENT
    ? { ...disk, diskDismissedPercent: null }
    : disk;
}

/** Measures in the background, so neither a slow command nor a failure holds anything up. */
export function recordComputerDisk(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  computerId: string,
  computer: ComputerRef,
  context: AdapterContext,
): void {
  void measureComputerDisk(deps.sandbox, computer, context)
    .then(async (disk) => {
      if (!disk) return;
      // Only while the same machine still runs: a late result must not touch a sleep claim or
      // describe a replacement.
      await deps.prisma.computer.updateMany({
        where: { id: computerId, state: "running", providerRef: computer.providerRef },
        data: diskUpdate(disk),
      });
    })
    .catch((error: unknown) => getLogger().warn("computer.disk_record_failed", { error }));
}

/** Percent full as df reports it, rounded up; null when never measured. */
export function diskUsedPercent(disk: StoredDisk): number | null {
  const { diskUsedBytes: used, diskFreeBytes: free } = disk;
  if (used == null || free == null || used + free === 0n) return null;
  return Number((used * 100n + used + free - 1n) / (used + free));
}

export function diskNoteInstruction(disk: StoredDisk): string | undefined {
  const percent = diskUsedPercent(disk);
  if (percent === null || percent < DISK_NOTE_PERCENT) return undefined;
  const free = Number(disk.diskFreeBytes);
  const size = free >= 1e9 ? `${Math.round(free / 1e9)} GB` : `${Math.round(free / 1e6)} MB`;
  return `The computer's disk is ${percent}% full (${size} free). Free space by removing build output and caches you no longer need, or tell the user.`;
}
