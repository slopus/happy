import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPartyApi, type PartyApi } from '../../vendor/agents-party/src/server/api.js';
import { createSqliteRegistry } from '../../vendor/agents-party/src/registry/sqlite.js';
import { createStorePool } from '../../vendor/agents-party/src/store/pool.js';
import { registryPath } from '../../vendor/agents-party/src/core/dirs.js';
import { decryptText, encryptText, generatePartyKey } from '../../vendor/agents-party/src/core/crypto.js';
import type { Message as PartyMessage, Recipients } from '../../vendor/agents-party/src/core/types.js';
import type { ImageRef, PartyEnvelope, RoleId } from '../contracts.js';
import { isAuthorized } from './auth.js';

export type PartyService = {
  api: PartyApi;
  bus: PartyBus;
  close(): Promise<void>;
};

export type DecodedPartyMessage = Omit<PartyMessage, 'text'> & { text: string; images: ImageRef[] };

export type PartyBus = {
  create(title: string): Promise<string>;
  createGroup(input: { title: string; participants: Array<{ id: string; description: string }> }): Promise<string>;
  send(input: { partyId: string; from: string; to: Recipients; text: string; images?: ImageRef[]; replyTo?: string }): Promise<PartyMessage>;
  read(partyId: string, options?: { since?: string }): Promise<DecodedPartyMessage[]>;
};

export async function createPartyService(dataDir: string, accessToken: string): Promise<PartyService> {
  const directory = join(dataDir, 'party');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const registry = await createSqliteRegistry(registryPath(directory));
  const pool = createStorePool(directory);
  const controller = new AbortController();
  const api = createPartyApi({
    registry,
    store: partyId => pool.get(partyId),
    removeStore: partyId => pool.remove(partyId),
    authOwner: async request => isAuthorized(request.headers.get('authorization') ?? undefined, accessToken)
      ? { ownerId: null }
      : null,
    zeroKnowledge: false,
    signal: controller.signal,
    listenSettleMs: 0,
  });

  const call = async (path: string, init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const response = await api(new Request(`http://127.0.0.1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...init.headers },
    }));
    if (!response) throw new Error(`Party route unavailable: ${path}`);
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `Party request failed (${response.status})`);
    return body;
  };

  const keyFor = async (partyId: string): Promise<string> => {
    const entry = await registry.get(partyId);
    if (!entry?.key) throw new Error('Party key unavailable.');
    return entry.key;
  };

  const bus: PartyBus = {
    async create(title) {
      const created = await call('/api/parties', { method: 'POST', body: JSON.stringify({ title, key: generatePartyKey() }) });
      const partyId = String(created.id);
      await call(`/api/parties/${partyId}/join`, { method: 'POST', body: JSON.stringify({ name: 'host', desc: 'Paws consultation owner' }) });
      for (const role of ['moderator', 'trend30', 'structure10', 'timing1'] satisfies RoleId[]) {
        await call(`/api/parties/${partyId}/join`, { method: 'POST', body: JSON.stringify({ name: role, desc: `Paws ${role} role` }) });
      }
      return partyId;
    },
    async createGroup(input) {
      const ids = input.participants.map(participant => participant.id);
      if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id))) {
        throw new Error('A group needs unique safe participant identifiers.');
      }
      const created = await call('/api/parties', { method: 'POST', body: JSON.stringify({ title: input.title, key: generatePartyKey() }) });
      const partyId = String(created.id);
      await call(`/api/parties/${partyId}/join`, { method: 'POST', body: JSON.stringify({ name: 'host', desc: 'Paws group owner' }) });
      for (const participant of input.participants) {
        await call(`/api/parties/${partyId}/join`, { method: 'POST', body: JSON.stringify({ name: participant.id, desc: participant.description.slice(0, 500) }) });
      }
      return partyId;
    },
    async send(input) {
      const envelope: PartyEnvelope = { v: 1, text: input.text, images: input.images ?? [] };
      const encrypted = await encryptText(await keyFor(input.partyId), JSON.stringify(envelope));
      const body = await call(`/api/parties/${input.partyId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ from: input.from, to: input.to, text: encrypted, ...(input.replyTo ? { replyTo: input.replyTo } : {}) }),
      });
      return body.message as PartyMessage;
    },
    async read(partyId, options) {
      const query = options?.since ? `?since=${encodeURIComponent(options.since)}` : '';
      const body = await call(`/api/parties/${partyId}/messages${query}`);
      const key = await keyFor(partyId);
      const decoded: DecodedPartyMessage[] = [];
      for (const message of body.messages as PartyMessage[]) {
        if (message.kind !== 'message') continue;
        const plaintext = await decryptText(key, message.text);
        if (plaintext === null) continue;
        try {
          const envelope = JSON.parse(plaintext) as Partial<PartyEnvelope>;
          if (envelope.v === 1 && typeof envelope.text === 'string' && Array.isArray(envelope.images)) {
            decoded.push({ ...message, text: envelope.text, images: envelope.images });
            continue;
          }
        } catch {}
        decoded.push({ ...message, text: plaintext, images: [] });
      }
      return decoded;
    },
  };
  return {
    api,
    bus,
    async close() {
      controller.abort();
      await pool.closeAll();
      await registry.close();
    },
  };
}
