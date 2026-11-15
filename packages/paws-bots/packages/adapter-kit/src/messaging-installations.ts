import type { MessagingSurface } from "./interfaces.js";
import type { MessagingCapabilities } from "./types.js";

/** A verified external workspace belongs to exactly one Rakazo space. */
export interface MessagingInstallation {
  id: string;
  provider: string;
  workspaceId: string;
  workspaceName: string;
  spaceId: string;
  userId: string;
  botId: string;
  credential: string;
}

export interface MessagingInstallationStore {
  get(provider: string, workspaceId: string): Promise<MessagingInstallation | null>;
  removeWorkspace(provider: string, workspaceId: string): Promise<void>;
  getById(id: string): Promise<MessagingInstallation | null>;
}

/** Vendor OAuth and credential translation stay in adapters. */
export interface MessagingInstallProvider {
  provider: string;
  capabilities: MessagingCapabilities;
  authorizeUrl(state: string): string;
  /** `ownerId` is the workspace user who authorized the install, when the platform says. */
  exchange(code: string): Promise<{
    workspaceId: string;
    workspaceName: string;
    credential: string;
    ownerId?: string;
  }>;
  parseWebhook(
    request: Request,
  ): Promise<{ request: Request; workspaceId?: string; challenge?: string; uninstalled?: boolean }>;
  surface(credential: string): MessagingSurface;
}
