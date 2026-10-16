import React from 'react';
import { createRoot } from 'react-dom/client';
import { MermaidRenderer } from '../../../sources/components/markdown/MermaidRenderer';
import { theme } from './theme';
// @ts-expect-error esbuild's text loader supplies the canonical Mermaid source.
import approvedDiagram from './approved.mmd';
// @ts-expect-error esbuild's text loader supplies the approved folding fixture.
import longDiagram from './steps.mmd';

// Separate synthetic special-shape graph: deliberately not eligible for folding,
// so long-image clipping remains covered without altering the approved input.
const tallDiagram = longDiagram.replace('I[Step 7 · 验证结果]', 'I((Step 7 · 验证结果))');
const wideDiagram = 'flowchart LR\n' + Array.from({ length: 12 }, (_, index) => `N${index}[阶段 ${index + 1}]`).join(' --> ');
const params = new URLSearchParams(location.search);
const diagram = params.get('shape') === 'arrows' ? 'flowchart LR\nA <--> B\nB ==> C\nC -.-> D\nD --o E\nE x--x F'
    : params.get('shape') === 'approved' ? approvedDiagram : params.get('shape') === 'wide' ? wideDiagram : params.get('shape') === 'tall' ? tallDiagram : longDiagram;
document.body.style.background = theme.colors.surface;
document.body.style.color = theme.colors.text;
createRoot(document.getElementById('root')!).render(
    <main style={{ maxWidth: 1060, margin: '0 auto', padding: 24 }}>
        <h3>流程图阅读验收 · 真实组件 / 合成内容</h3>
        <p id="body-reference" style={{ fontSize: 16, lineHeight: '24px' }}>正文对照：桌面流程图的文字应与这段正文大小相近，点击图片查看完整流程。</p>
        <MermaidRenderer content={diagram} />
        {params.get('shape') === 'compat' && <>
            <MermaidRenderer content={'sequenceDiagram\n用户->>服务: 请求\n服务-->>用户: 响应'} />
            <MermaidRenderer content={'classDiagram\nAnimal <|-- Cat'} />
            <MermaidRenderer content={'stateDiagram-v2\n[*] --> Ready\nReady --> Done'} />
        </>}
        <p id="following-message">这里是流程图之后的消息，长图不会把它推到几个屏幕之后。</p>
        <div style={{ height: 1000 }} aria-hidden="true" />
    </main>,
);
