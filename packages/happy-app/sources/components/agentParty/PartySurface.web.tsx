import * as React from 'react';
import { AGENT_PARTY_ORIGIN, type PartySurfaceProps } from './bridge';
export function PartySurface({ url, onMessage, onError }: PartySurfaceProps) {
    const frame = React.useRef<HTMLIFrameElement>(null);
    React.useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (event.origin === AGENT_PARTY_ORIGIN && event.source === frame.current?.contentWindow) onMessage(event.data);
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, [onMessage]);
    return <iframe ref={frame} title="Agent 群聊工作台" src={url} onError={onError} referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', border: 0, flex: 1 }} />;
}
