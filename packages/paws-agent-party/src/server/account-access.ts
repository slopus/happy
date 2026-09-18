import { createHash, createHmac, randomBytes } from 'node:crypto';
import { restorePawsCredentialsWithSecret, type PawsCredentials } from '@wangjs-jacky/paws-agent/browser';

export class AccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type VerifiedAccount = { id: string; name: string };
export type AccountSession = { account: VerifiedAccount; pawsToken: string; expires: number; checked: number };
export class AccountAccess {
  private tickets = new Map<string, AccountSession>();
  private sessions = new Map<string, AccountSession>();
  constructor(readonly serverUrl: string, private masterKey: string, private transport: typeof fetch = fetch, private now = Date.now) {}
  tenantKey(id: string) { return createHash('sha256').update(this.serverUrl + '\0' + id).digest('hex'); }
  tenantToken(id: string) { return createHmac('sha256', this.masterKey).update('agent-party-tenant\0' + this.tenantKey(id)).digest('base64url'); }
  async verify(token: string): Promise<VerifiedAccount> {
    if (!token || token.length > 8192) throw new AccessError(401, '请登录 Paws 后再继续。');
    let response: Response;
    try { response = await this.transport(`${this.serverUrl}/v1/account/profile`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new AccessError(503, '暂时无法验证 Paws 账号，请稍后重试。'); }
    if (response.status === 401 || response.status === 403) throw new AccessError(401, 'Paws 登录已失效，请重新登录。');
    if (!response.ok) throw new AccessError(503, 'Paws 账号服务暂不可用。');
    const profile = await response.json() as { id?: unknown; firstName?: string; username?: string };
    if (typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id)) throw new AccessError(502, '账号验证响应无效。');
    return { id: profile.id, name: profile.firstName || profile.username || '我的 Paws' };
  }
  async credentials(account: VerifiedAccount, encodedSecret: unknown): Promise<PawsCredentials> {
    if (typeof encodedSecret !== 'string' || !/^[A-Za-z0-9_+/-]{43}=?$/.test(encodedSecret)) throw new AccessError(400, '账号连接信息无效。');
    const secret = new Uint8Array(Buffer.from(encodedSecret, 'base64'));
    try {
      const credentials = await restorePawsCredentialsWithSecret({ serverUrl: this.serverUrl, secret, fetch: (url, init) => this.transport(url, { ...init, redirect: 'error' }), signal: AbortSignal.timeout(15000) });
      try {
        const proof = await this.verify(credentials.token);
        if (proof.id !== account.id) throw new AccessError(403, '账号连接信息与当前登录账号不匹配。');
        return credentials;
      } catch (error) {
        credentials.secret.fill(0); credentials.contentKeyPair.secretKey.fill(0);
        throw error;
      }
    } finally { secret.fill(0); }
  }
  issue(account: VerifiedAccount, pawsToken: string): string {
    this.prune();
    if (this.tickets.size >= 256 || this.sessions.size >= 2048) throw new AccessError(429, '连接较多，请稍后重试。');
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { account, pawsToken, checked: this.now(), expires: this.now() + 30000 });
    return ticket;
  }
  exchange(ticket: unknown): { token: string; account: VerifiedAccount } {
    this.prune();
    const value = typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
    if (!value) throw new AccessError(401, '连接已过期，请从 Paws 重新打开。');
    this.tickets.delete(ticket as string);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(this.hash(token), { ...value, expires: this.now() + 12 * 60 * 60 * 1000 });
    return { token, account: value.account };
  }
  async authenticate(token: string): Promise<AccountSession> {
    this.prune();
    const session = this.sessions.get(this.hash(token));
    if (!session) throw new AccessError(401, '请从 Paws 登录后继续。');
    if (this.now() - session.checked >= 60000) {
      const verified = await this.verify(session.pawsToken);
      if (verified.id !== session.account.id) { this.sessions.delete(this.hash(token)); throw new AccessError(401, '账号已改变，请重新打开。'); }
      session.checked = this.now();
    }
    this.assertActive(token, session);
    return session;
  }
  assertActive(token: string, session: AccountSession) {
    if (this.sessions.get(this.hash(token)) !== session || session.expires <= this.now()) throw new AccessError(401, '登录已失效，请重新打开。');
  }
  revokeAccount(id: string) {
    for (const map of [this.sessions, this.tickets]) for (const [key, value] of map) if (value.account.id === id) map.delete(key);
  }
  logout(token: string) { this.sessions.delete(this.hash(token)); }
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  private prune() { for (const map of [this.tickets, this.sessions]) for (const [key, value] of map) if (value.expires <= this.now()) map.delete(key); }
}
