import { createHmac } from "node:crypto";

export { isMonitoringUserId } from "./monitoring.js";

/**
 * The id error reports carry for a user: a keyed hash, so the collector can count affected users
 * without learning who they are. It is stable per secret, and distinct from the analytics id made
 * with the same secret, so the two collectors cannot join their records.
 */
export function monitoringUserId(secret: string, userId: string): string {
  return createHmac("sha256", secret).update(`monitoring-user:${userId}`).digest("hex");
}

/** Error reporting shares the analytics pseudonym secret; unset means reports carry no user. */
export function monitoringPseudonymSecret(source: NodeJS.ProcessEnv = process.env) {
  return source.ANALYTICS_PSEUDONYM_SECRET?.trim() || undefined;
}
