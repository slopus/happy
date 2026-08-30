const FRAME_ID = 'paws-agent-bubble-frame';
const COLLAPSED_SIZE = 76;
const EXPANDED_WIDTH = 390;
const EXPANDED_HEIGHT = 640;

if (window === window.top && !document.getElementById(FRAME_ID)) {
    const frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.dataset.pawsAgentBubble = 'true';
    frame.title = 'Paws Agent 悬浮会话';
    frame.src = chrome.runtime.getURL('panel.html');
    frame.allow = 'clipboard-write';
    Object.assign(frame.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        width: `${COLLAPSED_SIZE}px`,
        height: `${COLLAPSED_SIZE}px`,
        border: '0',
        borderRadius: '24px',
        background: 'transparent',
        colorScheme: 'light dark',
        zIndex: '2147483647',
        transition: 'width 180ms ease, height 180ms ease, border-radius 180ms ease',
        overflow: 'hidden',
    });
    document.documentElement.append(frame);

    const panelOrigin = new URL(frame.src).origin;
    window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow || event.origin !== panelOrigin) return;
        const message = event.data as { type?: unknown; expanded?: unknown } | null;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'paws:bubble:resize') {
            const expanded = message.expanded === true;
            frame.style.width = `${expanded ? EXPANDED_WIDTH : COLLAPSED_SIZE}px`;
            frame.style.height = `${expanded ? EXPANDED_HEIGHT : COLLAPSED_SIZE}px`;
            frame.style.borderRadius = expanded ? '26px' : '24px';
            if (expanded) sendPageContext(frame);
        }
        if (message.type === 'paws:bubble:request-context') sendPageContext(frame);
    });

    frame.addEventListener('load', () => sendPageContext(frame));
}

function sendPageContext(frame: HTMLIFrameElement): void {
    frame.contentWindow?.postMessage({
        type: 'paws:page-context',
        context: {
            title: document.title,
            url: window.location.href,
            selection: window.getSelection()?.toString() ?? '',
        },
    }, new URL(frame.src).origin);
}
