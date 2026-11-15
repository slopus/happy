import path from "node:path";
import type Docker from "dockerode";
import { COMPUTER_IMAGE } from "./computer-spec.js";
import { dataDir, docker } from "./context.js";
import { isManagedComputer } from "./supervisor-logic.js";

export async function findBotContainer(botId: string, spaceId: string) {
  const listed = await docker.listContainers({
    all: true,
    filters: {
      // Space IDs were preserved when workspaces became Spaces. Search by the
      // stable bot label, then validate either generation of the Space label.
      label: [`rakazo.botId=${botId}`],
    },
  });
  for (const item of listed) {
    const container = docker.getContainer(item.Id);
    const info = await container.inspect();
    if (isRakazoContainer(info, botId, spaceId)) return container;
  }
  return undefined;
}

/** Count managed computers for a space, including legacy workspaceId / unlabeled-managed. */
export async function countSpaceContainers(spaceId: string): Promise<number> {
  // Do not filter by rakazo.managed=true: legacy computers are still managed via
  // COMPUTER_IMAGE + rakazo.workspaceId (same rule as isRakazoContainer).
  const listed = await docker.listContainers({ all: true });
  let count = 0;
  for (const item of listed) {
    if (await isManagedSpaceContainer(item, spaceId)) count++;
  }
  return count;
}

async function isManagedSpaceContainer(
  item: Docker.ContainerInfo,
  spaceId: string,
): Promise<boolean> {
  const labels = item.Labels;
  if (labels) {
    const listedSpaceId = labels["rakazo.spaceId"] ?? labels["rakazo.workspaceId"];
    // Labeled for another space (or no space identity) cannot count toward this cap.
    if (listedSpaceId !== spaceId) return false;
    if (labels["rakazo.managed"] === "true" || item.Image === COMPUTER_IMAGE) return true;
    // Space matches but Image may be an ID after the tag moved — confirm via inspect.
  }
  // Missing list Labels: inspect with the same managed rule as isRakazoContainer.
  try {
    const info = await docker.getContainer(item.Id).inspect();
    const infoLabels = info.Config?.Labels ?? {};
    const managed =
      infoLabels["rakazo.managed"] === "true" || info.Config?.Image === COMPUTER_IMAGE;
    const infoSpaceId = infoLabels["rakazo.spaceId"] ?? infoLabels["rakazo.workspaceId"];
    return managed && infoSpaceId === spaceId;
  } catch {
    // Container might have been removed concurrently
    return false;
  }
}

export class ComputerIdentityError extends Error {}

export async function managedContainer(id: string, botId?: string, spaceId?: string) {
  if (!botId || !spaceId) throw new ComputerIdentityError("missing computer identity");
  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (!isRakazoContainer(info, botId, spaceId))
    throw new ComputerIdentityError("computer identity mismatch");
  return { container, info };
}

export function isRakazoContainer(
  info: Docker.ContainerInspectInfo,
  botId: string,
  spaceId: string,
) {
  return isManagedComputer(info, botId, spaceId, COMPUTER_IMAGE);
}

export function assertBotHomePath(homePath: string, botId: string) {
  const expected = path.join(dataDir, "homes", botId);
  if (homePath !== expected) {
    throw new Error("computer home must be the bot's home directory");
  }
}
