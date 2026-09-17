import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RunError } from '../server/runs.js';
import { DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_MODEL, isCodexEffort, isCodexModel, type CodexEffort, type CodexModel } from './codex-profile.js';
import type { RoomMember } from './routing.js';

/** The first group-chat release deliberately launches only Codex agents. */
export { DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_MODEL, type CodexEffort, type CodexModel } from './codex-profile.js';
export type AgentProfile = RoomMember & {
  engine: 'codex';
  model: CodexModel;
  effort: CodexEffort;
  createdAt: number;
  updatedAt: number;
};
export type AgentProfileInput = {
  name: string;
  instructions: string;
  model?: CodexModel;
  effort?: CodexEffort;
  /** Rejected when supplied with anything other than Codex, for a clear API error. */
  engine?: unknown;
};
type ProfilesFile = { profiles: AgentProfile[] };

export class ProfileService {
  private readonly profiles = new Map<string, AgentProfile>();
  private persistQueue: Promise<void> = Promise.resolve();
  private migratedLegacyProfiles = false;

  private constructor(private readonly path: string, file: ProfilesFile) {
    for (const profile of file.profiles ?? []) {
      const normalized = normalizeStoredProfile(profile);
      if (!sameProfile(profile, normalized)) this.migratedLegacyProfiles = true;
      this.profiles.set(normalized.id, normalized);
    }
  }

  static async create(dataDir: string): Promise<ProfileService> {
    const path = join(dataDir, 'group-chat-profiles.json');
    let file: ProfilesFile = { profiles: [] };
    try { file = JSON.parse(await readFile(path, 'utf8')) as ProfilesFile; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const service = new ProfileService(path, file);
    if (service.profiles.size === 0) {
      await Promise.all([
        service.create({ name: '产品经理', instructions: '澄清用户目标、范围和验收标准，关注产品价值。' }),
        service.create({ name: '技术负责人', instructions: '评估实现路径、工程成本、系统约束与风险。' }),
        service.create({ name: '质疑者', instructions: '寻找漏洞、反例、遗漏假设和不可逆风险。' }),
      ]);
    } else if (service.migratedLegacyProfiles) await service.persist();
    return service;
  }

  list(): AgentProfile[] { return [...this.profiles.values()].map(clone).sort((a, b) => a.createdAt - b.createdAt); }
  get(id: string): AgentProfile { const value = this.profiles.get(id); if (!value) throw new RunError(404, 'Agent profile not found.'); return clone(value); }

  async create(input: AgentProfileInput): Promise<AgentProfile> {
    const normalized = normalize(input);
    this.assertNameAvailable(normalized.name);
    const timestamp = Date.now();
    const profile: AgentProfile = { id: `agent-${randomUUID().replaceAll('-', '').slice(0, 16)}`, ...normalized, createdAt: timestamp, updatedAt: timestamp };
    this.profiles.set(profile.id, profile);
    await this.persist();
    return clone(profile);
  }

  async update(id: string, input: AgentProfileInput): Promise<AgentProfile> {
    const current = this.profiles.get(id); if (!current) throw new RunError(404, 'Agent profile not found.');
    const normalized = normalize(input);
    this.assertNameAvailable(normalized.name, id);
    Object.assign(current, normalized, { updatedAt: Date.now() });
    await this.persist();
    return clone(current);
  }

  members(ids: string[]): AgentProfile[] {
    if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) throw new RunError(400, 'Choose one or more distinct agents.');
    return ids.map(id => this.get(id));
  }

  private assertNameAvailable(name: string, exceptId?: string): void {
    if (this.list().some(profile => profile.id !== exceptId && profile.name === name)) throw new RunError(409, 'Agent display names must be unique.');
  }
  private persist(): Promise<void> {
    const payload: ProfilesFile = { profiles: this.list() };
    this.persistQueue = this.persistQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
      await rename(temp, this.path); await chmod(this.path, 0o600);
    });
    return this.persistQueue;
  }
}

function normalize(input: AgentProfileInput): Pick<AgentProfile, 'name' | 'instructions' | 'engine' | 'model' | 'effort'> {
  if (!input || typeof input.name !== 'string' || typeof input.instructions !== 'string') throw new RunError(400, 'An agent needs a name and role instructions.');
  if (input.engine !== undefined && input.engine !== 'codex') throw new RunError(400, 'This release supports Codex Agent profiles only.');
  const name = input.name.trim(); const instructions = input.instructions.trim();
  if (!name || name.length > 40 || /[@\n\r]/u.test(name)) throw new RunError(400, 'Agent name must be 1–40 characters and cannot contain @ or newlines.');
  if (!instructions || instructions.length > 4_000) throw new RunError(400, 'Agent role instructions must be 1–4000 characters.');
  const model = input.model ?? DEFAULT_CODEX_MODEL;
  const effort = input.effort ?? DEFAULT_CODEX_EFFORT;
  if (!isCodexModel(model)) throw new RunError(400, 'Unsupported Codex model.');
  if (!isCodexEffort(effort)) throw new RunError(400, 'Unsupported Codex thinking effort.');
  return { name, instructions, engine: 'codex', model, effort };
}
function normalizeStoredProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    engine: 'codex',
    model: isCodexModel(profile.model) ? profile.model : DEFAULT_CODEX_MODEL,
    effort: isCodexEffort(profile.effort) ? profile.effort : DEFAULT_CODEX_EFFORT,
  };
}
function sameProfile(left: AgentProfile, right: AgentProfile): boolean { return left.engine === right.engine && left.model === right.model && left.effort === right.effort; }
function clone<T>(value: T): T { return structuredClone(value); }
