import { MERMAID_VERSION, MERMAID_ELK_VERSION } from './mermaidRuntime';
import { serializeForInlineScript, type MermaidThemeConfig } from './mermaidRendererModel';
import { MERMAID_RUNTIME_SOURCE } from './mermaidRuntimeSource.generated';

export function buildNativeDocument(content: string, config: MermaidThemeConfig, fullscreen: boolean): string {
    const serializedContent = serializeForInlineScript(content);
    const serializedConfig = serializeForInlineScript(config);
    const background = fullscreen ? config.themeVariables.secondaryColor : config.themeVariables.background;
    const errorColor = config.themeVariables.primaryTextColor;

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
        html, body { height: 100%; margin: 0; overflow: hidden; background: ${background}; }
        body { padding: ${fullscreen ? '0px' : '46px 16px 16px'}; box-sizing: border-box; }
        #viewport { align-items: ${fullscreen ? 'center' : 'flex-start'}; box-sizing: border-box; display: flex; height: 100%; justify-content: center; overflow: hidden; touch-action: ${fullscreen ? 'none' : 'auto'}; width: 100%; }
        #viewport svg { height: 100%; max-height: 100%; max-width: 100%; width: 100%; }
        #scene { align-items: center; display: flex; flex-shrink: 0; height: 100%; justify-content: center; width: 100%; }
        #error { color: ${errorColor}; font-family: monospace; white-space: pre-wrap; }
    </style>
</head>
<body>
    <div id="viewport"><div id="scene"></div></div>
    <script>
        ${MERMAID_RUNTIME_SOURCE}
        (async function() {
            const content = ${serializedContent};
            const config = ${serializedConfig};
            const viewport = document.getElementById('viewport');
            const scene = document.getElementById('scene');
            let active = true;
            const pendingLoads = new Set();
            window.addEventListener('pagehide', function() {
                active = false;
                pendingLoads.forEach(function(cancel) { cancel(); });
                pendingLoads.clear();
            }, { once: true });
            const post = function(payload) {
                if (active && window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
            };
            const loadScript = function(url, globalName) {
                if (window[globalName]) return Promise.resolve();
                return new Promise(function(resolve, reject) {
                    const script = document.createElement('script');
                    let settled = false;
                    let timeout;
                    const finish = function(error) {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timeout);
                        script.onload = script.onerror = null;
                        script.remove();
                        pendingLoads.delete(cancel);
                        if (error) reject(error); else resolve();
                    };
                    const cancel = function() { finish(new Error('Diagram document unloaded')); };
                    pendingLoads.add(cancel);
                    script.onload = function() { finish(window[globalName] ? null : new Error(globalName + ' is unavailable')); };
                    script.onerror = function() { finish(new Error(globalName + ' script load failed')); };
                    timeout = setTimeout(function() { finish(new Error(globalName + ' script load timed out')); }, 20000);
                    script.async = true;
                    script.src = url;
                    try { document.head.appendChild(script); } catch (error) { finish(error); }
                });
            };
            try {
                await Promise.all([
                    loadScript('https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js', 'mermaid'),
                    ${fullscreen ? "loadScript('https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4.6.2/dist/panzoom.min.js', 'Panzoom')" : 'Promise.resolve()'}
                ]);
                if (!active) return;
                const runtime = pawsMermaidRuntime.createMermaidRuntime(mermaid, function() {
                    return new Promise(function(resolve, reject) {
                        const timeout = setTimeout(function() { reject(new Error('ELK layout load timed out')); }, 20000);
                        import('https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@${MERMAID_ELK_VERSION}/dist/mermaid-layout-elk.esm.min.mjs')
                            .then(function(module) { clearTimeout(timeout); resolve(module.default); }, function(error) { clearTimeout(timeout); reject(error); });
                    });
                });
                const markup = await runtime.render('mermaid-diagram', content, config);
                if (!active) return;
                scene.innerHTML = markup;
                const svg = scene.querySelector('svg');
                svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
                if (!${fullscreen}) {
                    scene.style.height = 'auto';
                    svg.style.width = '100%';
                    svg.style.height = 'auto';
                    svg.style.maxWidth = 'none';
                    svg.style.maxHeight = 'none';
                    svg.style.display = 'block';
                    let previousHeight = 0;
                    const reportHeight = function() {
                        const contentHeight = svg.getBoundingClientRect().height;
                        if (contentHeight <= 0) return;
                        const padding = getComputedStyle(document.body);
                        const height = Math.ceil(contentHeight + parseFloat(padding.paddingTop) + parseFloat(padding.paddingBottom));
                        if (height === previousHeight) return;
                        previousHeight = height;
                        post({ type: 'previewHeight', height: height });
                    };
                    reportHeight();
                    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(reportHeight).observe(scene);
                    return;
                }
                const box = svg.viewBox.baseVal;
                scene.style.width = box.width + 'px';
                scene.style.height = box.height + 'px';
                const fitScale = function() { return Math.min(1, Math.max(1, viewport.clientWidth - 32) / box.width, Math.max(1, viewport.clientHeight - 32) / box.height); };
                const controller = Panzoom(scene, { canvas: true, maxScale: 5, minScale: Math.min(0.1, fitScale() / 2), startScale: fitScale(), step: 0.25 });
                scene.addEventListener('panzoomchange', function(event) { post({ type: 'scale', scale: event.detail.scale }); });
                post({ type: 'scale', scale: fitScale() });
                viewport.addEventListener('wheel', function(event) {
                    if (!event.ctrlKey && !event.metaKey) return;
                    controller.zoomWithWheel(event);
                }, { passive: false });
                window.__pawsMermaid = {
                    reset: function() { controller.reset({ animate: true }); },
                    zoomIn: function() { controller.zoomIn({ animate: true }); },
                    zoomOut: function() { controller.zoomOut({ animate: true }); },
                    download: function() {
                        const snapshot = svg.cloneNode(true);
                        snapshot.style.transform = '';
                        snapshot.style.transformOrigin = '';
                        snapshot.removeAttribute('xmlns');
                        snapshot.querySelectorAll('[xmlns]').forEach(function(node) { node.removeAttribute('xmlns'); });
                        snapshot.setAttribute('width', String(box.width));
                        snapshot.setAttribute('height', String(box.height));
                        const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(snapshot));
                        const encoded = btoa(Array.from(bytes, function(byte) { return String.fromCharCode(byte); }).join(''));
                        post({ type: 'download', uri: 'data:image/svg+xml;base64,' + encoded });
                    }
                };
                if (typeof ResizeObserver !== 'undefined') {
                    let previousScale = fitScale();
                    new ResizeObserver(function() {
                        const nextScale = fitScale();
                        if (previousScale === nextScale) return;
                        previousScale = nextScale;
                        controller.setOptions({ startScale: nextScale, minScale: Math.min(0.1, nextScale / 2) });
                        controller.reset({ animate: false });
                    }).observe(viewport);
                }
            } catch (error) {
                if (!active) return;
                pendingLoads.forEach(function(cancel) { cancel(); });
                pendingLoads.clear();
                const errorNode = document.createElement('div');
                errorNode.id = 'error';
                errorNode.textContent = error && error.message ? error.message : String(error);
                viewport.replaceChildren(errorNode);
                post({ type: 'error' });
            }
        })();
    </script>
</body>
</html>`;
}
