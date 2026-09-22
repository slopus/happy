// Local, synthetic browser fixture. Imports the production virtualizer and
// coordinator; no account, server or real conversation data is used.
import React from 'react';
import { createRoot } from 'react-dom/client';
// @ts-expect-error RN Web does not publish declarations for this class export.
import VirtualizedList from 'react-native-web/dist/exports/VirtualizedList';
import { createAnchoredWebVirtualizedList } from '../../sources/components/anchoredWebVirtualizedList';
import { WebTranscriptScrollCoordinator } from '../../sources/components/webTranscriptScrollCoordinator';
const List = createAnchoredWebVirtualizedList(VirtualizedList);
const events: unknown[] = [];
function App() {
    const list = React.useRef<any>(null);
    const [rows, setRows] = React.useState(Array.from({ length: 100 }, (_, i) => 100 + i));
    const [revision, setRevision] = React.useState(0);
    const coordinator = React.useMemo(() => new WebTranscriptScrollCoordinator(() => ({
        scrollToOffset: options => { events.push({ type: 'write', ...options }); list.current.scrollToOffset(options); },
        scrollToIndex: options => list.current.scrollToIndex(options),
        scrollToEnd: options => list.current.scrollToEnd(options),
    })), []);
    React.useLayoutEffect(() => {
        const node = list.current.getScrollableNode();
        const wheel = (event: WheelEvent) => coordinator.userIntent(event.deltaY < 0 ? 'older' : 'newer');
        node.addEventListener('wheel', wheel, { passive: true });
        (window as any).scrollFixture = {
            events, coordinator,
            position: (offset: number) => coordinator.driver.scrollToOffset({ offset, animated: false }),
            prepend: () => {
                coordinator.userIntent('older');
                coordinator.beginHistory(String(rows[0]), 'older', true);
                setRows(previous => [...Array.from({ length: 20 }, (_, i) => previous[0] - 20 + i), ...previous]);
            },
            update: () => setRevision(value => value + 1),
            metrics: () => {
                const viewport = node.getBoundingClientRect();
                const mounted = [...node.querySelectorAll('[data-transcript-key]')] as HTMLElement[];
                const visible = mounted.find(row => row.getBoundingClientRect().bottom > viewport.top);
                return { offset: node.scrollTop, count: mounted.length, total: rows.length,
                    key: visible?.dataset.transcriptKey, top: visible ? visible.getBoundingClientRect().top - viewport.top : null };
            },
        };
        return () => node.removeEventListener('wheel', wheel);
    }, [rows, coordinator]);
    React.useEffect(() => { if (coordinator.history) coordinator.finishHistory(coordinator.history.id); }, [rows]);
    return <main style={{ maxWidth: 900, margin: '32px auto', fontFamily: 'system-ui' }}>
        <h1>Paws · 滚动事务浏览器回归</h1>
        <p>真实 RN Web 虚拟列表 · 合成历史数据 · 仅本机测试</p>
        <button onClick={() => (window as any).scrollFixture.prepend()}>插入 20 条历史</button>
        <span>　已加载 {rows.length} 条；普通更新 {revision}</span>
        <List ref={list} data={rows} getItem={(data: number[], index: number) => data[index]}
            getItemCount={(data: number[]) => data.length} keyExtractor={(id: number) => String(id)}
            getItemLayout={(_: unknown, index: number) => ({ index, length: 180, offset: index * 180 })}
            initialNumToRender={10} windowSize={5} maxToRenderPerBatch={10}
            scrollCoordinator={coordinator} historyBoundaryKeys={[String(rows[0]), 'end']}
            onScroll={() => coordinator.activity()} scrollEventThrottle={16}
            style={{ height: 600, overflowAnchor: 'none', border: '1px solid #ccc', marginTop: 20 }}
            renderItem={({ item }: { item: number }) => <article data-transcript-key={String(item)}
                style={{ height: 180, boxSizing: 'border-box', padding: 24, borderBottom: '1px solid #ddd' }}>
                <h3>合成消息 {item}</h3><p>用于核对 prepend 前后相同消息的可见位置。</p>
            </article>} />
    </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
