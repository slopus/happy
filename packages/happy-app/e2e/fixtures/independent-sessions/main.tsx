import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { IndependentSessionCard } from '../../../sources/components/IndependentSessionCard';
import { theme } from '../ai-services/theme';
import { parseMarkdown } from '../../../sources/components/markdown/parseMarkdown';

const markdown = ['Console 身份与存储只读核查', '独立 UI 与组件化准备'].map((title, i) =>
    `<happy-session>\n${JSON.stringify({ sessionId: `child-${i + 1}`, title })}\n</happy-session>`).join('\n');
function Fixture() {
    const [route, setRoute] = React.useState(location.pathname);
    React.useEffect(() => {
        const changed = () => setRoute(location.pathname);
        window.addEventListener('popstate', changed);
        return () => window.removeEventListener('popstate', changed);
    }, []);
    return <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
        <h2>独立会话 · 实际组件验收</h2>
        <p>合成会话数据；复用真实解析器与卡片。此页面不创建生产会话。</p>
        {parseMarkdown(markdown).map((block, i) => block.type === 'session-link' ? <IndependentSessionCard key={i} link={block.link} /> : null)}
        <button id="complete" onClick={() => window.dispatchEvent(new CustomEvent('fixture-state', { detail: 'completed' }))}>完成第一个任务</button>
        <button id="permission" onClick={() => window.dispatchEvent(new CustomEvent('fixture-state', { detail: 'permission' }))}>第二个任务等待权限</button>
        <output id="route">{route}</output>
    </main>;
}
document.body.style.background = theme.colors.groupped.background;
document.body.style.color = theme.colors.text;
createRoot(document.getElementById('root')!).render(<Fixture />);
