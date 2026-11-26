import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { UsageDialog } from '../../../sources/components/usage/UsageDialog';
import { machine } from './data';

function Fixture() {
    const [open, setOpen] = React.useState(true);
    const [, setRevision] = React.useState(0);
    return <>
        <nav aria-label="验收操作" style={{ padding: 12, display: 'flex', gap: 12 }}>
            <button onClick={() => setOpen(true)}>打开使用情况</button>
            <button onClick={() => {
                machine.daemonState = { codexUsage: { ...machine.daemonState.codexUsage, scannedAt: machine.daemonState.codexUsage.scannedAt + 1000 } };
                setRevision(value => value + 1);
            }}>更新演示快照</button>
            <a href="/?theme=dark">深色主题</a><a href="/?theme=light">浅色主题</a>
        </nav>
        <UsageDialog open={open} onClose={() => setOpen(false)} />
    </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
