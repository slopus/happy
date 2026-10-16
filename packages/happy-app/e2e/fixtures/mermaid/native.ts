// @ts-expect-error serve.mjs exposes the private builder only in this test bundle.
import { buildNativeDocument } from '../../../sources/components/markdown/MermaidRenderer';
import { createMermaidThemeConfig } from '../../../sources/components/markdown/mermaidRendererModel';
import { theme } from './theme';
// @ts-expect-error esbuild's text loader supplies the canonical Mermaid source.
import approvedDiagram from './approved.mmd';
// @ts-expect-error esbuild's text loader supplies the canonical chain source.
import stepsDiagram from './steps.mmd';

// Actual Native HTML + CDN/ELK, hosted in Chromium; not a native-device test.
const frame = document.createElement('iframe');
frame.id = 'native-webview';
Object.assign(frame.style, { width: '100vw', height: '100vh', border: '0', display: 'block' });
const html = buildNativeDocument(new URLSearchParams(location.search).get('shape') === 'steps' ? stepsDiagram : approvedDiagram, createMermaidThemeConfig(theme), true);
frame.srcdoc = html.replace('<head>', '<head><script>window.ReactNativeWebView={postMessage:function(value){parent.postMessage(JSON.parse(value),"*");}};</script>');
document.getElementById('root')!.append(frame);
