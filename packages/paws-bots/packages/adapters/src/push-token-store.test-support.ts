import { credentialDigest } from "./credential-digest.js";
import type { PushRecord, PushTokenStore } from "./push-token-store.js";

export class MemoryPushTokenStore implements PushTokenStore {
  private readonly rows = new Map<string, PushRecord>();
  async load(userId: string) {
    return this.rows.get(userId);
  }
  async save(userId: string, token: string, sessionId = "", presentation?: "android_sender") {
    for (const [owner, row] of this.rows) if (row.token === token) this.rows.delete(owner);
    this.rows.set(userId, {
      token,
      ...(sessionId ? { sessionId } : {}),
      ...(presentation ? { presentation } : {}),
    });
  }
  async importLegacy(userId: string, token: string, sessionId: string) {
    if (this.rows.has(userId) || [...this.rows.values()].some((row) => row.token === token))
      return false;
    await this.save(userId, token, sessionId);
    return true;
  }
  async remove(userId: string, digest?: string) {
    const row = this.rows.get(userId);
    if (row && (!digest || credentialDigest(row.token) === digest)) this.rows.delete(userId);
  }
  async endSession(userId: string, sessionId: string, nextSessionId?: string) {
    const row = this.rows.get(userId);
    if (row?.sessionId !== sessionId) return;
    if (nextSessionId) this.rows.set(userId, { ...row, sessionId: nextSessionId });
    else this.rows.delete(userId);
  }
}
