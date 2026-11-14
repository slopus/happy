import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageComposer } from '@/components/MessageComposer';
import { resolveComposerReferences } from '@/sync/composerReferences';
import { theme } from './boundaries';
(window as any).fixtureEvents = [];
function App() {
    const [mode, setMode] = React.useState<'home' | 'session'>('home');
    const [initial, setInitial] = React.useState('');
    const [images, setImages] = React.useState<any[]>([]);
    const [saved, setSaved] = React.useState('');
    const [seed, setSeed] = React.useState(0);
    const [received, setReceived] = React.useState('');
    const [uploads, setUploads] = React.useState(0);
    const ref = React.useRef<any>(null);
    (window as any).fixture = { getDraft: () => ref.current.getText(), events: (window as any).fixtureEvents };
    return <main style={{ background: theme.colors.groupped.background, color: theme.colors.text, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <header style={{ padding: 20 }}>实际输入组件 · 合成来源与传输
            <button id="mode" onClick={() => setMode(m => m === 'home' ? 'session' : 'home')}>{mode}</button>
            <button id="initial-at" onClick={() => { setInitial('@'); setSeed(s => s + 1); }}>恢复 @ 草稿</button>
            <button id="restore" onClick={() => { setInitial(saved); setSeed(s => s + 1); }}>恢复当前草稿</button>
            <button id="attach" onClick={() => setImages(i => i.length ? [] : [{ id: 'img', uri: 'synthetic', width: 100, height: 100 }])}>切换图片</button>
            <span id="uploads">选择文件次数：{uploads}</span>
        </header>
        <pre id="received" style={{ whiteSpace: 'pre-wrap', overflow: 'auto', flex: 1 }}>{received}</pre>
        <div style={{ overflow: 'hidden' }}><MessageComposer key={`${mode}:${seed}`} ref={ref} mode={mode} sessionId={mode === 'session' ? 'current' : undefined}
            initialValue={initial} onChangeText={setSaved} placeholder="输入消息" selectedImages={images}
            onSend={async () => { const result = await resolveComposerReferences(ref.current.getText(), { isCurrent: () => true, session: async id => `User: REAL_SOURCE_CONTENT_${id}`, plugin: async () => ({ title: 'Image gallery', description: 'Browse existing images' }) });setReceived(result.text); }}
            onPickImages={() => setUploads(v => v + 1)} /></div>
    </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
