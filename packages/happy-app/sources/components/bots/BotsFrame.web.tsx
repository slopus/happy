import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { loadBotsAssets } from './botsAssets.web';

type HostOptions = Omit<BotsFrameProps, 'expiresAt'> & { expiresAt: number; theme: Record<string, string> };
declare global {
    interface Window { PawsBots?: { mount(element: HTMLElement, options: HostOptions): () => void } }
}
export type BotsFrameProps = {
    active?: boolean;
    runtimeUrl: string;
    ticket: string;
    expiresAt: number;
    onAuthenticated: () => void;
    onFailure: () => void;
};

/** Mount the workspace's compiled React application directly in the Paws document. */
export function BotsFrame(props: BotsFrameProps) {
    const element = React.useRef<HTMLDivElement>(null);
    const { theme } = useUnistyles();
    const colors = React.useMemo(() => ({
        '--background': theme.colors.surface,
        '--primary': theme.colors.button.primary.background,
        '--primary-foreground': theme.colors.button.primary.tint,
        '--primary-hover': theme.colors.fab.backgroundPressed,
        '--primary-disabled': theme.colors.button.primary.disabled,
        '--chat-user': theme.colors.surfaceSelected,
        '--chat-user-foreground': theme.colors.text,
        '--faint-foreground': theme.colors.textSecondary,
        '--input': theme.colors.input.background,
        '--ring': theme.colors.accent,
        '--link': theme.colors.textLink,
        '--destructive': theme.colors.textDestructive,
        '--destructive-fill': theme.colors.button.destructive.background,
        '--destructive-foreground': theme.colors.button.destructive.tint,
        '--success': theme.colors.success,
        '--warning': theme.colors.warning,
        '--status-working': theme.colors.status.connecting,
        '--unread': theme.colors.accent,
        '--working-dot': theme.colors.status.connected,
        '--overlay': theme.colors.modal.backdrop,
        '--scrollbar': theme.colors.divider,
        '--scrollbar-hover': theme.colors.textSecondary,
        '--glass-fill': theme.colors.surfaceHigh,
        '--glass-stroke': theme.colors.modal.border,
        '--foreground': theme.colors.text,
        '--card': theme.colors.surface,
        '--card-foreground': theme.colors.text,
        '--dialog': theme.colors.surface,
        '--popover': theme.colors.surface,
        '--popover-foreground': theme.colors.text,
        '--muted': theme.colors.surfacePressed,
        '--muted-foreground': theme.colors.textSecondary,
        '--secondary': theme.colors.surfacePressed,
        '--secondary-foreground': theme.colors.text,
        '--accent': theme.colors.surfaceSelected,
        '--accent-foreground': theme.colors.text,
        '--sidebar': theme.colors.surface,
        '--sidebar-foreground': theme.colors.text,
        '--sidebar-accent': theme.colors.surfaceSelected,
        '--sidebar-accent-foreground': theme.colors.text,
        '--border': theme.colors.divider,
        '--sidebar-border': theme.colors.divider,
    }), [theme]);
    React.useEffect(() => {
        const host = element.current;
        if (!host) return;
        let cancelled = false;
        let dispose: (() => void) | undefined;
        let releaseAssets: (() => void) | undefined;
        let entry = document.querySelector<HTMLMetaElement>('meta[name="paws-bots-entry"]')?.content;
        let css = document.querySelector<HTMLMetaElement>('meta[name="paws-bots-style"]')?.content;
        const fail = () => { if (!cancelled) props.onFailure(); };
        void (async () => {
            // Expo dev serves generated public assets; release HTML pins immutable names.
            if ((!entry || !css) && __DEV__) {
                const response = await fetch('/bots-assets/manifest.json', { cache: 'no-store' });
                if (!response.ok) throw new Error('Build the Bots workspace before starting Web');
                const manifest = await response.json(); entry = manifest.js; css = manifest.css;
            }
            if (!entry || !css) throw new Error('Bots workspace assets are missing');
            if (cancelled) return;
            const assets = loadBotsAssets(entry, css);
            releaseAssets = assets.dispose;
            const runtime = await assets.ready;
            if (cancelled) return;
            if (Date.now() >= props.expiresAt) throw new Error('Bots launch expired');
            dispose = runtime.mount(host, { ...props, theme: colors });
        })().catch(fail);
        return () => { cancelled = true; dispose?.(); releaseAssets?.(); };
    }, [props.runtimeUrl, props.ticket, props.expiresAt, props.onAuthenticated, props.onFailure]);
    React.useEffect(() => {
        const host = element.current;
        if (!host) return;
        host.dataset.pawsActive = props.active === false ? 'false' : 'true';
        host.dispatchEvent(new Event('paws-bots-visibility'));
    }, [props.active]);
    React.useEffect(() => {
        for (const [name, value] of Object.entries(colors)) element.current?.style.setProperty(name, value);
    }, [colors]);
    return React.createElement('div', { ref: element, 'data-testid': 'bots-runtime-root', style: { display: 'block', width: '100%', height: '100%', minHeight: 0 } });
}
