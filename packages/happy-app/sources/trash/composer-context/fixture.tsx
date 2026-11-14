import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageComposer } from '@/components/MessageComposer';
import { theme } from './boundaries';
function App() {
    const [mode, setMode] = React.useState<'home' | 'session'>('home');
    const [uploads, setUploads] = React.useState(0);
    return <main style={{ background: theme.colors.groupped.background, color: theme.colors.text, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <header style={{ padding: 20 }}>输入框分类浮层 · 真实组件 / 合成数据 <button id="mode" onClick={() => setMode(m => m === 'home' ? 'session' : 'home')}>{mode}</button> <span id="uploads">文件选择器调用：{uploads}</span></header>
        <div style={{ flex: 1 }} />
        <div style={{ overflow: 'hidden' }}><MessageComposer key={mode} mode={mode} sessionId={mode === 'session' ? 'current' : undefined} initialValue="" placeholder="输入消息" onSend={() => {}} onPickImages={() => setUploads(v => v + 1)} /></div>
    </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
