import React from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownView } from '../../../sources/components/markdown/MarkdownView';
import { theme } from '../ai-services/theme';

const markdown = `理解。你希望 PROMPT.md 能直接成为 Happy 新会话的任务入口：

- 主会话负责对齐目标、拆分任务。
- 对于可以并行的独立任务，分别开启新对话，带入对应任务和必要上下文。
- 新会话完成各自任务，把结果写回对应任务目录。

这样，你就不必手动新建对话、复制提示词、再解释背景。

我还需要确认一个关键点：哪些任务开启新会话，由谁决定？

<options>
<option>AI 提议并行任务，我确认后批量开启</option>
<option>我逐个选择任务并开启</option>
<option>目标和任务确认后，AI 自动开启可并行任务</option>
</options>`;

function Fixture() {
    const [revision, setRevision] = React.useState(0);
    const [sent, setSent] = React.useState<string[]>([]);
    const [failNext, setFailNext] = React.useState(false);
    const [error, setError] = React.useState('');
    React.useEffect(() => {
        const handler = () => setError('发送失败，请重试。回答已保留。');
        window.addEventListener('fixture-send-error', handler);
        return () => window.removeEventListener('fixture-send-error', handler);
    }, []);
    return <>
        <header style={{ borderBottom: `1px solid ${theme.colors.divider}`, padding: '12px 24px', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>问答卡片 · 浏览器验收</strong>
            <button id="reset" onClick={() => { setRevision(value => value + 1); setSent([]); setError(''); }}>重置用例</button>
            <label><input id="fail-next" type="checkbox" checked={failNext} onChange={event => setFailNext(event.target.checked)} />下次发送模拟失败</label>
            <small>真实组件 / 隔离发送接口 / 不连接生产会话</small>
        </header>
        <main style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 20px' }}>
            <MarkdownView key={revision} markdown={markdown} typography="chatMono" onOptionPress={async ({ title }) => {
                const response = await fetch('/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, fail: failNext }) });
                setFailNext(false);
                if (!response.ok) throw new Error('Fixture send failed');
                setError(''); setSent(values => [...values, title]);
            }} />
            <div id="error" role="alert" style={{ color: theme.colors.textDestructive, marginTop: 12 }}>{error}</div>
            <section style={{ marginTop: 24, padding: 16, borderRadius: 16, background: theme.colors.surface }}>
                <small>隔离接口收到的回答（成功提交后显示）</small>
                <div id="sent-count" data-count={sent.length}>{sent.length} 条</div>
                <div id="sent-replies">{sent.map((reply, index) => <p key={index}>{reply}</p>)}</div>
            </section>
        </main>
    </>;
}
document.body.style.background = theme.colors.groupped.background;
document.body.style.color = theme.colors.text;
createRoot(document.getElementById('root')!).render(<Fixture />);
