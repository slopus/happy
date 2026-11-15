import { createHash } from "node:crypto";
import type { CloudAgentProvider } from "@rakazo/adapter-kit";
import { EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";

/** The composition root binds a credential to exactly one authorized Space. */
export interface CloudAgentConnection {
  provider: CloudAgentProvider;
  /** Opaque credential binding. Rotation fails closed for existing agents. */
  key: string;
  /** A user's own environment, disclosed for consent; a new one asks again. */
  baseUrl?: string;
  /** Only the offline emulator may be available in every Space. */
  spaceId?: string;
}

export type CloudAgentActor = { spaceId: string; userId: string };

/** Environments users connected themselves as MCP servers, wherever those servers reach. */
export interface UserCloudAgents {
  /**
   * The actor's connection for new agents, if any. With `botIds`, require each agent's
   * permission to use the complete bridge protocol; without, list for owner consent.
   */
  forActor(actor: CloudAgentActor & { botIds?: string[] }): Promise<CloudAgentConnection | null>;
  /** Every environment the actor connected in the Space, whichever agents may use it. */
  listForActor(actor: CloudAgentActor): Promise<CloudAgentConnection[]>;
  /** Resolve a stored key; with botIds, require current permission to start new work. */
  forKey(
    key: string,
    actor: CloudAgentActor & { botIds?: string[] },
  ): Promise<CloudAgentConnection | null>;
}

/** Their agents are keyed by this prefix and the MCP server's id, which survives a reconnect. */
export const USER_CLOUD_AGENT_KEY_PREFIX = "mcp:";

export function cloudAgentsEnabled(
  connection: CloudAgentConnection | null | undefined,
  spaceId: string,
) {
  return Boolean(
    connection &&
      (connection.spaceId === spaceId ||
        (!connection.spaceId && connection.provider.describe().capabilities.offline)),
  );
}

export function createCloudAgentConnection(
  source: NodeJS.ProcessEnv = process.env,
): CloudAgentConnection | null {
  const kind = resolveCloudAgentProvider(source);
  if (kind === "emulator") {
    return { provider: new EmulatorCloudAgentProvider(), key: "emulator" };
  }
  if (kind !== "cursor") return null;
  const apiKey = source.CURSOR_API_KEY!.trim();
  const spaceId = source.CLOUD_AGENT_SPACE_ID!.trim();
  return {
    provider: new CursorCloudAgentProvider({ apiKey }),
    key: `cursor:${createHash("sha256").update(apiKey).digest("hex")}`,
    spaceId,
  };
}
