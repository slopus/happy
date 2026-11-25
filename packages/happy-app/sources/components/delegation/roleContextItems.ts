import type { DelegationRole } from '@slopus/happy-wire';
import { t } from '@/text';
import type { ContextItem } from '../autocomplete/contextItems';

/** A role inserts a request into the existing draft; selection never dispatches. */
export function roleContextItems(roles: readonly DelegationRole[]): ContextItem[] {
    return roles.map(role => ({
        id: `agent-role:${role.id}`,
        category: 'agents',
        title: role.name,
        detail: `${role.id} · ${role.agent === 'antigravity' ? 'Antigravity' : 'Codex'} / ${role.model || t('delegation.nativeDefault')}${role.effort ? ` · ${role.effort}` : ''}`,
        text: t('delegation.useRolePrompt', { id: role.id, name: role.name.replace(/\s+/g, ' ') }),
        icon: 'git-branch-outline',
        provider: role.agent,
    }));
}
