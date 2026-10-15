import React from 'react';
import { createRoot } from 'react-dom/client';
import { MermaidRenderer } from '../../../sources/components/markdown/MermaidRenderer';
import { theme } from './theme';

const longDiagram = `flowchart TD
    A[Step 1 · 澄清目标<br/>了解问题、期望结果和限制] --> B[Step 2 · 汇总目标<br/>复述目标、范围与完成标准]
    B --> C{确认目标？}
    C -->|未确认 / 继续补充| A
    C -->|确认| D[Step 3 · 拆分任务]
    D --> E[Step 4 · 汇总任务]
    E --> F{确认任务？}
    F -->|调整| D
    F -->|确认| G[Step 5 · 准备执行]
    G --> H[Step 6 · 实施任务]
    H --> I[Step 7 · 验证结果]
    I --> J{达到完成标准？}
    J -->|否| H
    J -->|是| K[Step 8 · 交付成果]`;
const wideDiagram = 'flowchart LR\n' + Array.from({ length: 12 }, (_, index) => `N${index}[阶段 ${index + 1}]`).join(' --> ');
const params = new URLSearchParams(location.search);
document.body.style.background = theme.colors.surface;
document.body.style.color = theme.colors.text;
createRoot(document.getElementById('root')!).render(
    <main style={{ maxWidth: 1060, margin: '0 auto', padding: 24 }}>
        <h3>流程图阅读验收 · 真实组件 / 合成内容</h3>
        <p id="body-reference" style={{ fontSize: 16, lineHeight: '24px' }}>正文对照：桌面流程图的文字应与这段正文大小相近，点击图片查看完整流程。</p>
        <MermaidRenderer content={params.get('shape') === 'wide' ? wideDiagram : longDiagram} />
        <p id="following-message">这里是流程图之后的消息，长图不会把它推到几个屏幕之后。</p>
        <div style={{ height: 1000 }} aria-hidden="true" />
    </main>,
);
