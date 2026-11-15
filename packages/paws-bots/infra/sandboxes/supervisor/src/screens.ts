import { randomUUID } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import type Docker from "dockerode";
import { screenPorts } from "./computer-spec.js";
import { teamScreenLimit } from "./context.js";
import { runContainerCommand } from "./exec.js";
import { managedContainer } from "./identity.js";
import { withComputerScreenLock } from "./locks.js";
import { rejoinComputerNetwork } from "./networks.js";
import type { ScreenAssignment } from "./supervisor-logic.js";
import {
  browserProfilePathForScreen,
  clearComputerScreenRegistry,
  currentComputerScreens,
  ensureScreenCommand,
  interactiveScreenCommand,
  nextScreenIndex,
  oldestIdleScreen,
  releaseAssignedScreen,
  resetManagedScreensCommand,
  screenRecentlyEnsured,
  stopExtraScreenCommand,
  teardownReleasedScreen,
} from "./supervisor-logic.js";

export const computerScreens = new Map<string, Map<string, ScreenAssignment>>();
// Container start time each screen registry was built under; see currentComputerScreens.
export const computerScreenBoots = new Map<string, string>();

export async function managedScreen(
  id: string,
  botId: string | undefined,
  spaceId: string | undefined,
  screenId: string | undefined,
  screenLeaseId: string | undefined,
  restoreControl = true,
  reuseRecent = false,
) {
  const { container } = await managedContainer(id, botId, spaceId);
  return withComputerScreenLock(id, async () => {
    if (reuseRecent) {
      const recent = await recentManagedScreen(id, container, botId, screenId, screenLeaseId);
      if (recent) return recent;
    }
    const screen = await ensureManagedScreen(
      id,
      container,
      botId,
      screenId,
      screenLeaseId,
      restoreControl,
    );
    return { ...screen, reused: false };
  });
}

/** Skip the setup script for a screen set up moments ago on this boot; callers hold the screen lock. */
async function recentManagedScreen(
  id: string,
  container: Docker.Container,
  botId: string | undefined,
  screenId: string | undefined,
  screenLeaseId: string | undefined,
) {
  const info = await container.inspect();
  const startedAt = info.State?.StartedAt;
  const assigned = currentComputerScreens(computerScreens, computerScreenBoots, id, startedAt);
  const screenKey = screenId || botId || id;
  const slot = assigned?.get(screenKey);
  if (!assigned || !startedAt || computerScreenBoots.get(id) !== startedAt) return undefined;
  if (!slot?.viewToken || !screenRecentlyEnsured(slot, Date.now())) return undefined;
  // Still fence the lease: an older execution must not drive this screen.
  const index = nextScreenIndex(assigned, screenKey, screenLeaseId, teamScreenLimit);
  return {
    container,
    info,
    layout: screenPorts(index),
    index,
    screenKey,
    browserProfile: browserProfilePathForScreen(screenKey),
    viewToken: slot.viewToken,
    reused: true,
  };
}

export async function ensureManagedScreen(
  id: string,
  container: Docker.Container,
  botId: string | undefined,
  screenId: string | undefined,
  screenLeaseId: string | undefined,
  restoreControl = true,
) {
  // Docker can restart independently of the supervisor's screen lock.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const screen = await ensureManagedScreenAttempt(
      id,
      container,
      botId,
      screenId,
      screenLeaseId,
      restoreControl,
    );
    const info = await container.inspect();
    if (info.State?.StartedAt === screen.info.State?.StartedAt) {
      // Confirm the pending boot marker only after setup completes against the same boot.
      if (info.State?.StartedAt) computerScreenBoots.set(id, info.State.StartedAt);
      const slot = computerScreens.get(id)?.get(screen.screenKey);
      if (slot) slot.ensuredAt = Date.now();
      try {
        await rejoinComputerNetwork(info);
      } catch (error) {
        getLogger().error("computer network rejoin failed", error);
      }
      return { ...screen, info };
    }
    clearComputerScreenRegistry(computerScreens, computerScreenBoots, id);
  }
  throw new Error("computer restarted during screen setup");
}

async function ensureManagedScreenAttempt(
  id: string,
  container: Docker.Container,
  botId: string | undefined,
  screenId: string | undefined,
  screenLeaseId: string | undefined,
  restoreControl = true,
) {
  // Callers hold the screen lock: an inspection before waiting can describe an older boot.
  const info = await container.inspect();
  let assigned = currentComputerScreens(
    computerScreens,
    computerScreenBoots,
    id,
    info.State?.StartedAt,
  );
  if (!assigned) {
    const reset = await runContainerCommand(container, [
      "bash",
      "-c",
      resetManagedScreensCommand(),
    ]);
    if (reset.code !== 0) throw new Error(reset.stderr || "computer screens failed to reset");
    assigned = new Map();
    computerScreens.set(id, assigned);
    // Remember the inspected boot even if setup or teardown fails before confirmation.
    if (info.State?.StartedAt) computerScreenBoots.set(id, info.State.StartedAt);
  }
  const screenKey = screenId || botId || id;
  if (!assigned.has(screenKey)) {
    const usedIndexes = new Set([...assigned.values()].map((slot) => slot.index));
    const hasFreeIndex = Array.from({ length: teamScreenLimit }, (_, index) => index).some(
      (index) => !usedIndexes.has(index),
    );
    if (!hasFreeIndex) {
      const evictedScreenId = oldestIdleScreen(assigned, teamScreenLimit);
      const evicted = evictedScreenId ? assigned.get(evictedScreenId) : undefined;
      if (evictedScreenId && evicted) {
        const evictedIndex = releaseAssignedScreen(assigned, evictedScreenId, evicted.leaseId);
        if (evictedIndex !== undefined) {
          await teardownReleasedScreen(assigned, evictedScreenId, evictedIndex, () =>
            runContainerCommand(container, [
              "bash",
              "-c",
              stopExtraScreenCommand(evictedIndex, evictedScreenId),
            ]),
          );
        }
      }
    }
  }
  const index = nextScreenIndex(assigned, screenKey, screenLeaseId, teamScreenLimit);
  const layout = screenPorts(index);
  const slot = assigned.get(screenKey)!;
  slot.viewToken ??= randomUUID();
  const viewToken = slot.viewToken;
  const ensured = await runContainerCommand(container, [
    "bash",
    "-c",
    ensureScreenCommand(index, screenKey, viewToken),
  ]);
  if (ensured.code !== 0) {
    const browserLog = await runContainerCommand(container, [
      "bash",
      "-c",
      `tail -c 4000 /tmp/rakazo/screen-${layout.displayNumber}-browser.log 2>/dev/null || true`,
    ]).catch(() => ({ stdout: "", stderr: "", code: 1 }));
    releaseAssignedScreen(assigned, screenKey);
    await teardownReleasedScreen(assigned, screenKey, index, () =>
      runContainerCommand(container, ["bash", "-c", stopExtraScreenCommand(index, screenKey)]),
    );
    if (assigned.size === 0) clearComputerScreenRegistry(computerScreens, computerScreenBoots, id);
    const detail = [ensured.stderr, browserLog.stdout].filter(Boolean).join("\n").trim();
    throw new Error(detail || `computer screen ${layout.display} failed to start`);
  }
  // Ensuring the view must also recover an active human lease after its VNC process dies.
  if (restoreControl && slot.controlToken) {
    await setInteractiveScreen(container, true, slot.controlToken, layout);
  }
  return {
    container,
    info,
    layout,
    index,
    screenKey,
    browserProfile: browserProfilePathForScreen(screenKey),
    viewToken,
  };
}

export async function setInteractiveScreen(
  container: Docker.Container,
  interactive: boolean,
  controlToken: string | undefined,
  layout: ReturnType<typeof screenPorts>,
) {
  const result = await runContainerCommand(container, [
    "bash",
    "-c",
    interactiveScreenCommand(interactive, controlToken, layout),
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "control screen failed to start");
  return interactive || !controlToken || result.stdout.includes("RAKAZO_CONTROL_RELEASED\n");
}
