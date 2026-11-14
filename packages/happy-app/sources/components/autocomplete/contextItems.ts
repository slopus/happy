import type { PluginCatalogItem } from '@slopus/happy-wire';
import { interactivePreviewEventSchema } from '@slopus/happy-wire';
import type { Message } from '@/sync/typesMessage';
import type { Session } from '@/sync/storageTypes';
import { isRetiredSession } from '@/sync/retiredSessions';
import { isSessionArchived } from '@/utils/sessionLifecycle';
import { compareSessionActivity } from '@/utils/sessionActivity';

export type ContextCategory = 'all' | 'files' | 'plugins' | 'sites' | 'sessions';
export type ContextItem = { id: string; category: Exclude<ContextCategory, 'all'>; title: string; detail: string; text: string; icon: 'document-text-outline' | 'folder-outline' | 'extension-puzzle-outline' | 'globe-outline' | 'chatbubble-outline' | 'attach-outline'; action?: 'upload' };

export function contextPlugins(plugins: readonly PluginCatalogItem[], label: (text: PluginCatalogItem['manifest']['title']) => string): ContextItem[] {
    return plugins.filter(p => p.status.installed).map(({ manifest }) => ({
        id: `plugin:${manifest.id}`, category: 'plugins', title: label(manifest.title),
        detail: label(manifest.description), icon: 'extension-puzzle-outline',
        // Explicit, portable reference; never include configuration or secrets.
        text: `@${label(manifest.title)} [plugin:${manifest.id}]`,
    }));
}

export function contextSessions(sessions: Record<string, Session>, currentId: string | undefined, name: (s: Session) => string): ContextItem[] {
    return Object.values(sessions).filter(s => s.id !== currentId && !isRetiredSession(s) && !isSessionArchived(s))
        .sort(compareSessionActivity).map(s => ({
            id: `session:${s.id}`, category: 'sessions', title: name(s), detail: s.metadata?.path ?? '',
            icon: 'chatbubble-outline', text: `@${name(s).replace(/[\[\]\n]/g, ' ')} [session:${s.id}]`,
        }));
}

/** Only published preview cards from loaded conversations, never arbitrary tool output URLs. */
export function contextSites(histories: Record<string, { messages: Message[] }>, now = Date.now()): ContextItem[] {
    const previews = new Map<string, { item: ContextItem; at: number }>();
    const visit = (messages: Message[]) => {
        for (const message of messages) {
            if (message.kind !== 'tool-call') continue;
            if (message.tool.name === 'interactive-preview') {
                const parsed = interactivePreviewEventSchema.safeParse(message.tool.input);
                if (parsed.success) {
                    const p = parsed.data;
                    // A later expired/failed card supersedes an earlier ready card.
                    if ((previews.get(p.id)?.at ?? -1) <= message.createdAt) {
                        let url: URL | null = null;
                        try { url = p.url ? new URL(p.url) : null; } catch { /* invalid source */ }
                        const ready = p.state === 'ready' && (!p.expiresAt || p.expiresAt > now)
                            && url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
                        previews.set(p.id, { at: message.createdAt, item: {
                            id: `site:${p.id}`, category: 'sites', title: p.title, detail: url?.host ?? '',
                            icon: 'globe-outline', text: ready ? `[${p.title.replace(/[\[\]\n]/g, ' ')}](${url!.href})` : '',
                        } });
                    }
                }
            }
            visit(message.children);
        }
    };
    Object.values(histories).forEach(h => visit(h.messages));
    const urls = new Set<string>();
    return [...previews.values()].sort((a, b) => b.at - a.at).map(p => p.item).filter(p => {
        if (!p.text || urls.has(p.text)) return false;
        urls.add(p.text); return true;
    });
}

export function filterContextItems(items: ContextItem[], category: ContextCategory, query: string): ContextItem[] {
    const term = query.trim().toLocaleLowerCase();
    return items.filter(item => (category === 'all' || item.category === category)
        && (!term || (item.category === 'files' && !item.action) || `${item.title} ${item.detail}`.toLocaleLowerCase().includes(term)));
}
