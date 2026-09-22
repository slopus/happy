import { PawsAgentError } from '../client/errors';
import type { SessionOrganization, SessionOrganizationInput, SessionOrganizationCatalog, PawsCredentials } from '../client/types';
import { decodeBase64, encodeBase64, encryptLegacy, decryptLegacy } from '../crypto/encryption';
import type { PawsHttpTransport } from '../transport/http';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message: string): never => { throw new PawsAgentError('PROTOCOL_UNSUPPORTED', message); };
const invalid = (message: string): never => { throw new PawsAgentError('INVALID_ARGUMENT', message); };
const text = (v: unknown, limit: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= limit;
export function validateOrganization(input: SessionOrganizationInput): void {
    if (!object(input)) invalid('organization must be an object');
    if (input.listId !== undefined && input.listName !== undefined) invalid('Choose listId or listName');
    if (input.tagIds !== undefined && input.tagNames !== undefined) invalid('Choose tagIds or tagNames');
    if (input.listId !== undefined && input.listId !== null && !text(input.listId, 100)) invalid('Invalid listId');
    if (input.listName !== undefined && !text(input.listName, 80)) invalid('Invalid listName');
    for (const [value, limit] of [[input.tagIds, 100], [input.tagNames, 80]] as const) {
        if (value !== undefined && (!Array.isArray(value) || value.length > 100 || value.some(v => !text(v, limit)))) invalid('Invalid tags');
    }
}
function decodeSettings(value: unknown, credentials: PawsCredentials): ObjectValue {
    if (value === null) return {};
    if (typeof value !== 'string') return fail('Malformed account settings');
    let result: unknown;
    try { result = decryptLegacy(decodeBase64(value), credentials.secret); } catch { /* handled below */ }
    if (!object(result)) throw new PawsAgentError('DECRYPTION_FAILED', 'Unable to decrypt account settings');
    return result;
}
function organization(settings: ObjectValue): SessionOrganizationCatalog {
    const value = settings.sidebarOrganization;
    if (value === undefined) return { lists: [], tags: [], sessions: {} };
    if (!object(value) || !Array.isArray(value.lists) || !Array.isArray(value.tags) || !object(value.sessions)) return fail('Malformed sidebar organization');
    // Preserve all unknown fields. Never normalize away data written by newer clients.
    for (const entries of [value.lists, value.tags]) {
        if (entries.some(v => !object(v) || !text(v.id, 100) || !text(v.name, 80))) return fail('Malformed organization entries');
        if (new Set(entries.map(v => v.id)).size !== entries.length) return fail('Duplicate organization IDs');
    }
    for (const assignment of Object.values(value.sessions)) {
        if (!object(assignment) || !(assignment.listId === null || typeof assignment.listId === 'string')
            || !Array.isArray(assignment.tagIds) || assignment.tagIds.some(v => typeof v !== 'string')) return fail('Malformed session organization');
    }
    return value as SessionOrganizationCatalog;
}
function resolveName(entries: Array<{ id: string; name: string; [key: string]: unknown }>, name: string, kind: 'list' | 'tag'): string {
    const normalized = name.trim();
    const matches = entries.filter(v => v.name.trim() === normalized);
    if (matches.length > 1) invalid('Ambiguous organization name; use an ID');
    if (matches.length) return matches[0].id;
    if (entries.length >= (kind === 'list' ? 200 : 500)) invalid('Organization entry limit exceeded');
    const id = `${kind}_${globalThis.crypto.randomUUID()}`;
    entries.push({ id, name: normalized, color: 'blue', createdAt: Date.now(),
        ...(kind === 'list' ? { kind: 'workspace', machineId: null, path: null, defaultAgent: null } : {}) });
    return id;
}
export class SessionOrganizationStore {
    constructor(private readonly http: PawsHttpTransport) {}
    private async read() {
        const snapshot = await this.http.getWithCredentials<{ settings: string | null; settingsVersion: number }>('/v1/account/settings');
        if (!Number.isSafeInteger(snapshot.data?.settingsVersion) || snapshot.data.settingsVersion < 0) fail('Malformed settings version');
        const settings = decodeSettings(snapshot.data.settings, snapshot.credentials);
        return { ...snapshot, settings, organization: organization(settings) };
    }
    async get(): Promise<SessionOrganizationCatalog> { return (await this.read()).organization; }
    async set(sessionId: string, input: SessionOrganizationInput, credentials: PawsCredentials): Promise<SessionOrganization> {
        validateOrganization(input);
        const owner = encodeBase64(credentials.secret);
        for (let attempt = 0; attempt < 4; attempt++) {
            const snapshot = await this.read();
            const identity = encodeBase64(snapshot.credentials.secret);
            if (owner !== identity) throw new PawsAgentError('AUTH_EXPIRED', 'Account changed during organization update');
            const org = snapshot.organization;
            const before = JSON.stringify(org);
            const previous = Object.hasOwn(org.sessions, sessionId) ? org.sessions[sessionId] : { listId: null, tagIds: [] };
            const listId = input.listName !== undefined ? resolveName(org.lists, input.listName, 'list')
                : input.listId === undefined ? previous.listId : input.listId;
            const tagIds = input.tagNames !== undefined ? input.tagNames.map(name => resolveName(org.tags, name, 'tag'))
                : input.tagIds === undefined ? previous.tagIds : input.tagIds;
            if (listId !== null && !org.lists.some(v => v.id === listId)) throw new PawsAgentError('NOT_FOUND', 'List not found');
            if (tagIds.some(id => !org.tags.some(v => v.id === id))) throw new PawsAgentError('NOT_FOUND', 'Tag not found');
            const assignment = { ...previous, listId, tagIds: [...new Set(tagIds)] };
            // Computed property avoids __proto__ assignment; spread preserves other sessions.
            org.sessions = { ...org.sessions, [sessionId]: assignment };
            if (JSON.stringify(org) === before) return assignment;
            const response = await this.http.post<{ success: boolean; error?: string }>('/v1/account/settings', {
                settings: encodeBase64(encryptLegacy({ ...snapshot.settings, sidebarOrganization: org }, snapshot.credentials.secret)),
                expectedVersion: snapshot.data.settingsVersion,
            }, { expectedCredentials: snapshot.credentials });
            if (response?.success === true) return assignment;
            if (response?.success !== false || response.error !== 'version-mismatch') fail('Settings update was not acknowledged');
        }
        throw new PawsAgentError('CONNECTION_LOST', 'Account settings kept changing; retry organization update');
    }
}
