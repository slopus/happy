import * as React from 'react';

export type BotsFrameProps = {
    runtimeUrl: string;
    ticket: string;
    expiresAt: number;
    onAuthenticated: () => void;
    onFailure: () => void;
};

/** The upstream UI receives a one-use ticket, never a Paws credential. */
export function BotsFrame({ runtimeUrl, ticket, expiresAt, onAuthenticated, onFailure }: BotsFrameProps) {
    const frame = React.useRef<HTMLIFrameElement>(null);
    const sent = React.useRef(false);
    const origin = new URL(runtimeUrl).origin;
    const send = React.useCallback(() => {
        if (sent.current) return;
        if (Date.now() >= expiresAt) { onFailure(); return; }
        const child = frame.current?.contentWindow;
        if (!child) return;
        sent.current = true;
        child.postMessage({ type: 'paws:rakazo:launch', ticket }, origin);
    }, [expiresAt, onFailure, origin, ticket]);
    React.useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
            if (event.data?.type === 'paws:rakazo:ready') send();
            else if (event.data?.type === 'paws:rakazo:authenticated') onAuthenticated();
            else if (event.data?.type === 'paws:rakazo:error') onFailure();
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, [onAuthenticated, onFailure, origin, send]);
    return React.createElement('iframe', {
        ref: frame,
        src: runtimeUrl,
        title: 'Bots',
        'data-testid': 'bots-runtime-frame',
        referrerPolicy: 'no-referrer',
        allow: 'clipboard-write; microphone; camera; fullscreen',
        onLoad: send,
        onError: onFailure,
        style: { display: 'block', width: '100%', height: '100%', minHeight: 0, border: 0 },
    });
}
