import { describe, expect, it, vi } from 'vitest';
import type { DelegationRole } from '@slopus/happy-wire';
vi.mock('@/text', () => ({ t: (key: string, args?: { id: string; name: string }) => args ? `Use ${args.name} (roleId=${args.id})` : key }));
import { roleContextItems } from './roleContextItems';
import { filterContextItems } from '../autocomplete/contextItems';

describe('role invocation choices', () => {
    it('disambiguates same-name roles by stable id and keeps executor/model defaults visible', () => {
        const base = { name: 'Technical writer', description: 'Write documentation', autoDelegate: false, createdAt: 1, updatedAt: 1 };
        const roles: DelegationRole[] = [
            { ...base, id: 'role-a', agent: 'antigravity', model: 'Neon', effort: 'High' },
            { ...base, id: 'role-b', agent: 'codex' },
        ];
        const choices = roleContextItems(roles);
        expect(filterContextItems(choices, 'agents', 'role-b')).toEqual([expect.objectContaining({ provider: 'codex', text: 'Use Technical writer (roleId=role-b)' })]);
        expect(choices[0].detail).toContain('Neon · High');
        expect(choices[1].detail).toContain('delegation.nativeDefault');
        expect(roles[1].model).toBeUndefined();
    });
});
