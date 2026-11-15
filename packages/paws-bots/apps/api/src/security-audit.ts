import type { SecurityEventInput, SecurityEventType } from "@rakazo/db";
import { recordSecurityEvent } from "@rakazo/db";

type AuditedProcedure = {
  type: SecurityEventType;
  /** What kind of credential or setting changed. */
  kind?: string;
  /**
   * Input fields copied into metadata, by dotted path; the metadata key is the last segment.
   * Identifiers and enums only, never values a user typed.
   */
  fields?: readonly string[];
};

/**
 * Procedures that create, change, or remove a credential or a security setting. One table, so a
 * new credential route is audited by adding a line here instead of a call in its handler.
 */
export const AUDITED_PROCEDURES: Record<string, AuditedProcedure> = {
  "models.connect": { type: "credential.created", kind: "model", fields: ["provider"] },
  "models.finishOAuth": { type: "credential.created", kind: "model" },
  "models.disconnect": { type: "credential.deleted", kind: "model", fields: ["provider"] },
  "mcp.servers.create": { type: "credential.created", kind: "mcp" },
  "mcp.servers.update": { type: "credential.changed", kind: "mcp", fields: ["id"] },
  "mcp.servers.remove": { type: "credential.deleted", kind: "mcp", fields: ["id"] },
  "mcp.oauth.complete": { type: "credential.created", kind: "mcp_oauth" },
  "mcp.oauth.disconnect": { type: "credential.deleted", kind: "mcp_oauth", fields: ["serverId"] },
  "capabilities.install": { type: "credential.created", kind: "connector", fields: ["kind"] },
  "capabilities.remove": { type: "credential.deleted", kind: "connector", fields: ["id"] },
  "connections.revoke": {
    type: "credential.deleted",
    kind: "connection",
    fields: ["connectionId"],
  },
  "integrationSetup.save": { type: "credential.changed", kind: "integration_provider" },
  "agentSecrets.put": { type: "credential.changed", kind: "agent_secret" },
  "agentSecrets.remove": { type: "credential.deleted", kind: "agent_secret", fields: ["id"] },
  "botSecrets.put": {
    type: "credential.changed",
    kind: "bot_secret",
    fields: ["botId", "destination.name"],
  },
  "botSecrets.remove": {
    type: "credential.deleted",
    kind: "bot_secret",
    fields: ["botId", "name"],
  },
  "vault.put": {
    type: "credential.changed",
    kind: "vault_credential",
    fields: ["scope", "destination.name"],
  },
  "vault.remove": {
    type: "credential.deleted",
    kind: "vault_credential",
    fields: ["scope", "name"],
  },
  "bots.rotateWebhookSecret": { type: "credential.changed", kind: "webhook", fields: ["botId"] },
  "voice.connect": { type: "credential.created", kind: "voice", fields: ["provider"] },
  "voice.disconnect": { type: "credential.deleted", kind: "voice", fields: ["provider"] },
  "memory.connectProvider": { type: "credential.created", kind: "memory" },
  "memory.disconnectProvider": { type: "credential.deleted", kind: "memory" },
  // Starting a sign-in replaces any wallet already connected.
  "paymentWallet.connect": { type: "credential.changed", kind: "payment_wallet" },
  "paymentWallet.disconnect": { type: "credential.deleted", kind: "payment_wallet" },
  "deployment.update": {
    type: "deployment.settings.changed",
    fields: ["signupsEnabled", "computerHost"],
  },
  "computerProvider.update": {
    type: "credential.changed",
    kind: "computer_provider",
    fields: ["provider"],
  },
  "computerProvider.account.update": {
    type: "credential.changed",
    kind: "computer_provider",
    fields: ["provider"],
  },
  "mcp.assignments.approve": {
    type: "approval.decided",
    kind: "mcp",
    fields: ["botId", "serverId"],
  },
  "mcp.assignments.dismiss": {
    type: "approval.decided",
    kind: "mcp",
    fields: ["botId", "serverId"],
  },
  "approvalRules.set": { type: "approval.policy.changed", fields: ["effect", "matchKind"] },
  "approvalRules.remove": { type: "approval.policy.changed", fields: ["id"] },
  "models.setRole": { type: "approval.policy.changed", fields: ["role", "scope"] },
  "autoReview.set": { type: "approval.policy.changed", fields: ["enabled", "skipApprovals"] },
  "spendingLimit.set": {
    type: "approval.policy.changed",
    kind: "spending_limit",
    fields: ["limit.currency", "limit.period"],
  },
  "spaceSettings.setOverride": {
    type: "approval.policy.changed",
    fields: ["setting", "enabled"],
  },
};

/**
 * A connection becoming connected. Clients poll `connections.complete`, so the handler records
 * this on the transition instead of the table recording every call.
 */
export function connectionCreatedEvent(
  procedure: "connections.begin" | "connections.catalog" | "connections.complete",
  connectionId: string,
  actor: { userId: string; spaceId: string },
): SecurityEventInput {
  return {
    type: "credential.created",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { procedure, kind: "connection", connectionId },
  };
}

/** A wallet sign-in finishing. Clients poll `paymentWallet.status`, so it records the transition. */
export function paymentWalletConnectedEvent(actor: {
  userId: string;
  spaceId: string;
}): SecurityEventInput {
  return {
    type: "credential.created",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { procedure: "paymentWallet.status", kind: "payment_wallet" },
  };
}

/** The event for a procedure that just succeeded, or undefined when it is not audited. */
export function procedureSecurityEvent(
  path: readonly string[],
  input: unknown,
  actor: { userId: string; spaceId: string },
): SecurityEventInput | undefined {
  const procedure = path.join(".");
  const audited = AUDITED_PROCEDURES[procedure];
  if (!audited) return undefined;
  const fields = isRecord(input) ? input : {};
  const metadata: NonNullable<SecurityEventInput["metadata"]> = { procedure };
  if (audited.kind) metadata.kind = audited.kind;
  for (const field of audited.fields ?? []) {
    const value = field
      .split(".")
      .reduce<unknown>((parent, key) => (isRecord(parent) ? parent[key] : undefined), fields);
    if (typeof value === "string" || typeof value === "boolean" || value === null)
      metadata[field.split(".").at(-1)!] = value;
  }
  if (procedure === "deployment.update") {
    metadata.changed = Object.keys(fields)
      .filter((key) => fields[key] !== undefined)
      .sort()
      .join(",");
  }
  if (procedure === "mcp.assignments.approve") metadata.decision = "allow";
  if (procedure === "mcp.assignments.dismiss") metadata.decision = "deny";
  return { type: audited.type, userId: actor.userId, spaceId: actor.spaceId, metadata };
}

const FAILED_CREDENTIAL_PATHS: Record<string, SecurityEventType> = {
  "/sign-in/email": "auth.sign_in.failed",
  "/sign-in/email-otp": "auth.sign_in.failed",
  "/passkey/verify-authentication": "auth.sign_in.failed",
  "/sign-up/email": "auth.sign_up.failed",
};
const RATE_LIMIT_EVENT_WINDOW_MS = 60_000;
const RATE_LIMIT_KEYS_MAX = 10_000;

/**
 * Failed credential attempts and rate-limit hits, read from the auth response. Rejections thrown
 * before Better Auth's own hooks run (closed registration, a rate limit) only show up here.
 */
export function createAuthResponseAudit(now: () => number = Date.now) {
  // A limited client can keep hammering; one row per address, path, and minute is the signal.
  const rateLimited = new Map<string, number>();
  return async (path: string, ip: string | undefined, response: Response): Promise<void> => {
    if (response.status === 429) {
      const key = `${ip ?? "unknown"}|${path}`;
      const at = now();
      const last = rateLimited.get(key);
      if (last !== undefined && at - last < RATE_LIMIT_EVENT_WINDOW_MS) return;
      if (rateLimited.size >= RATE_LIMIT_KEYS_MAX) rateLimited.clear();
      rateLimited.set(key, at);
      await recordSecurityEvent({ type: "rate_limit.hit", ip, metadata: { path } });
      return;
    }
    const failed = FAILED_CREDENTIAL_PATHS[path];
    if (!failed || response.status < 400) return;
    await recordSecurityEvent({
      type: failed,
      ip,
      metadata: { path, status: response.status, reason: await errorCode(response) },
    });
  };
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    const code = isRecord(body) ? body.code : undefined;
    return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
