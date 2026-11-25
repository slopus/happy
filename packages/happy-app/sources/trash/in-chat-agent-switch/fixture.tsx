import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageComposer } from '@/components/MessageComposer';
import { theme } from '../composer-context/boundaries';
function App() {
    const [pending, setPending] = React.useState<string | null>(null);
    const [events, setEvents] = React.useState<string[]>([]);
    const [busy, setBusy] = React.useState(false);
    const ref = React.useRef<any>(null);
    const submit = (action: string) => { setEvents(value => [...value, `${action}: ${ref.current.getText()}`]); };
    (window as any).switchFixture = { events, pending, busy };
    return <main style={{ height: '100%', display: 'flex', flexDirection: 'column', background: theme.colors.groupped.background, color: theme.colors.text }}>
        <header style={{ padding: 24, display: 'flex', gap: 12, alignItems: 'center' }}>
            <strong>Paws · 输入框组件交互验收</strong>
            <button id="select-agent" onClick={() => setPending('antigravity')}>选择 Antigravity</button>
            <button id="cancel-agent" onClick={() => setPending(null)}>取消选择</button>
            <button id="toggle-busy" onClick={() => setBusy(value => !value)}>切换提交中</button>
        </header>
        <section style={{ padding: 24, flex: 1 }}>
            <p>基于实际 MessageComposer 源码；执行器与服务端不在此组件验收范围。</p>
            <p id="pending">待发送设置：{pending ?? 'Codex'}</p>
            <pre id="actions">{events.join('\n')}</pre>
        </section>
        <div style={{ padding: 24, maxWidth: 980, width: '100%', margin: '0 auto' }}>
            <MessageComposer ref={ref} mode="session" sessionId="component-acceptance" initialValue="继续修复解析器" placeholder="输入消息"
                newSessionAgent={pending} onSend={() => submit('同聊天发送')} onNewSession={() => submit('新建会话')} isSending={busy} />
        </div>
    </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
