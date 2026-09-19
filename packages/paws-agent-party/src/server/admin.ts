import { randomUUID } from 'node:crypto';
import { rename, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type VisitorPolicy = {
  enabled: boolean;
  tokenLimit: number | null;
  allowImages: boolean;
  allowAutoDebate: boolean;
  maxConcurrentVisitors: number;
};

export type AdminDashboard = {
  ownerAccountId?: string;
  visitors: { total: number; active24h: number };
  usage: { estimatedTokens: number; note: string };
  policy: VisitorPolicy;
  guestExecutorReady: boolean;
};

type State = {
  ownerAccountId?: string;
  policy: VisitorPolicy;
  visits: Array<{ id: string; at: number }>;
  estimatedTokens: number;
};

const defaultPolicy = (): VisitorPolicy => ({
  enabled: false,
  tokenLimit: 200_000,
  allowImages: true,
  allowAutoDebate: false,
  maxConcurrentVisitors: 4,
});

export class AdminService {
  private readonly path: string;
  private state: State;

  private constructor(path: string, state: State) { this.path = path; this.state = state; }

  static async create(dataDir: string): Promise<AdminService> {
    const path = join(dataDir, 'admin.json');
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<State>;
      return new AdminService(path, {
        ownerAccountId: typeof parsed.ownerAccountId === 'string' ? parsed.ownerAccountId : undefined,
        policy: normalizePolicy(parsed.policy),
        visits: Array.isArray(parsed.visits) ? parsed.visits.filter((value): value is { id: string; at: number } => !!value && typeof value.id === 'string' && Number.isFinite(value.at)).slice(-10_000) : [],
        estimatedTokens: typeof parsed.estimatedTokens === 'number' && parsed.estimatedTokens >= 0 ? parsed.estimatedTokens : 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new AdminService(path, { policy: defaultPolicy(), visits: [], estimatedTokens: 0 });
    }
  }

  dashboard(): AdminDashboard {
    const cutoff = Date.now() - 86_400_000;
    return {
      ...(this.state.ownerAccountId ? { ownerAccountId: this.state.ownerAccountId } : {}),
      visitors: { total: this.state.visits.length, active24h: this.state.visits.filter(value => value.at >= cutoff).length },
      usage: { estimatedTokens: this.state.estimatedTokens, note: 'AgentParty 当前没有上游逐次 Token 回传；此处仅显示保守估算，不能作为账单。' },
      policy: this.state.policy,
      guestExecutorReady: false,
    };
  }

  async claimOrAuthorize(accountId: string): Promise<boolean> {
    if (!this.state.ownerAccountId) { this.state.ownerAccountId = accountId; await this.save(); return true; }
    return this.state.ownerAccountId === accountId;
  }

  async updatePolicy(input: Partial<VisitorPolicy>): Promise<VisitorPolicy> {
    this.state.policy = normalizePolicy({ ...this.state.policy, ...input });
    await this.save();
    return this.state.policy;
  }

  async recordVisit(): Promise<{ visitorId: string; policy: Pick<VisitorPolicy, 'enabled' | 'tokenLimit' | 'allowImages'>; guestExecutorReady: false }> {
    this.state.visits.push({ id: randomUUID(), at: Date.now() });
    if (this.state.visits.length > 10_000) this.state.visits.splice(0, this.state.visits.length - 10_000);
    await this.save();
    const { enabled, tokenLimit, allowImages } = this.state.policy;
    return { visitorId: this.state.visits.at(-1)!.id, policy: { enabled, tokenLimit, allowImages }, guestExecutorReady: false };
  }

  private async save(): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function normalizePolicy(input: unknown): VisitorPolicy {
  const candidate = input && typeof input === 'object' ? input as Partial<VisitorPolicy> : {};
  const tokenLimit = candidate.tokenLimit === null ? null : typeof candidate.tokenLimit === 'number' && Number.isSafeInteger(candidate.tokenLimit) && candidate.tokenLimit >= 0 && candidate.tokenLimit <= 2_000_000 ? candidate.tokenLimit : 200_000;
  return {
    enabled: candidate.enabled === true,
    tokenLimit,
    allowImages: candidate.allowImages !== false,
    allowAutoDebate: candidate.allowAutoDebate === true,
    maxConcurrentVisitors: typeof candidate.maxConcurrentVisitors === 'number' && Number.isSafeInteger(candidate.maxConcurrentVisitors) && candidate.maxConcurrentVisitors >= 1 && candidate.maxConcurrentVisitors <= 32 ? candidate.maxConcurrentVisitors : 4,
  };
}
