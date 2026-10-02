import React, { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageStagingQueueView } from '@/components/MessageStagingQueueView';
import { createMessageStagingQueue, type StagingSession } from '@/sync/messageStagingQueue';
import { theme } from './boundaries';

let current: StagingSession = { connected: true, state: 'running', turnId: 'initial', supportsSteer: true };
let version = 0;
const listeners = new Set<() => void>();
const calls: string[] = [];
const messages: string[] = [];
function update(next: Partial<StagingSession>) { current = { ...current, ...next }; version++; listeners.forEach(fn => fn()); queue.refresh(); }
const queue = createMessageStagingQueue({
    load: () => ({ messages: [], barriers: {} }), save: () => undefined,
    session: () => current,
    steer: async (message, turnId) => { calls.push(`steer:${turnId}:${message.text}`); messages.push(message.text); },
    send: async message => {
        calls.push(`send:${message.text}`); messages.push(message.text);
        update({ state: 'running', turnId: message.id });
    },
});
(window as any).fixture = { calls, queue, update };
function App() {
    const [draft, setDraft] = useState('');
    const [visible, setVisible] = useState(true);
    const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
    useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => version);
    return <main style={{ background: theme.colors.groupped.background, color: theme.colors.text, height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        <h2>消息暂存队列</h2>
        <p>受控组件验收 · {current.state === 'running' ? '任务进行中' : '任务已结束'}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button id="finish" onClick={() => update({ state: 'completed' })}>结束当前任务</button>
            <button id="route" onClick={() => setVisible(v => !v)}>切换会话视图</button>
            <button id="connection" onClick={() => update({ connected: !current.connected })}>{current.connected ? '断开连接' : '恢复连接'}</button>
        </div>
        <section style={{ flex: 1, overflow: 'auto' }}><h3>已发送</h3>{messages.map((m, i) => <p key={i}>{m}</p>)}</section>
        {visible && <div style={{ width: '100%', maxWidth: 760, margin: '0 auto' }}>
            <MessageStagingQueueView messages={snapshot.messages} connected={current.connected} onRemove={queue.remove} onSteer={id => { void queue.steer(id); }} onEdit={m => { if (!draft) { setDraft(m.text); queue.remove(m.id); } }} />
            <textarea aria-label="消息" value={draft} onChange={e => setDraft(e.target.value)} style={{ width: '100%', height: 90, padding: 16, borderRadius: 16, background: theme.colors.surface, color: theme.colors.text }} />
            <button id="send" disabled={!draft.trim()} onClick={() => { queue.enqueue({ id: crypto.randomUUID(), sessionId: 'fixture', text: draft, modeMeta: {} }); setDraft(''); }}>发送</button>
        </div>}
    </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
