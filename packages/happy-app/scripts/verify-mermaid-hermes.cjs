// Usage: node scripts/verify-mermaid-hermes.cjs /absolute/path/to/hermes
// Real Hermes generates the HTML; a simulated DOM executes its bootstrap with
// dependency stubs. This is engine coverage, not an Android/WebView device test.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');

async function main() {
    const hermes = process.argv[2];
    if (!hermes) throw new Error('Pass the Hermes CLI executable as the first argument');
    const diagram = 'flowchart TB\nA[正文输出] --> B[完成]';
    const compiled = buildSync({
        stdin: {
            contents: `
                import { buildNativeDocument } from './mermaidNativeDocument';
                import { createMermaidThemeConfig } from './mermaidRendererModel';
                const config = createMermaidThemeConfig({ dark: false, colors: { text: '#222', textSecondary: '#555', surface: '#fff', surfaceHigh: '#eee', surfaceHighest: '#ddd', surfacePressed: '#ccc', divider: '#ccc' } });
                print(JSON.stringify([false, true].map(fullscreen => ({ fullscreen, html: buildNativeDocument(${JSON.stringify(diagram)}, config, fullscreen) }))));
            `,
            resolveDir: resolve(__dirname, '../sources/components/markdown'), loader: 'ts',
        },
        bundle: true, write: false, format: 'iife', minify: true, target: 'es2017',
    }).outputFiles[0].text;
    const output = execFileSync(hermes, ['-O', '-'], { input: compiled, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const documents = JSON.parse(output);
    for (const { fullscreen, html } of documents) {
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const browser = dom.window;
        const messages = [];
        browser.ReactNativeWebView = { postMessage: value => messages.push(JSON.parse(value)) };
        browser.SVGElement.prototype.getBoundingClientRect = () => ({ height: 60 });
        browser.mermaid = { initialize() {}, registerLayoutLoaders() {}, async render(_id, source) {
            assert.equal(source, diagram);
            assert.equal(source.split('\n').length, 2);
            return { svg: '<svg viewBox="0 0 100 60"><text>正文输出</text></svg>' };
        } };
        browser.Panzoom = target => {
            assert.equal(target.tagName, 'DIV');
            return { reset() {}, zoomIn() {}, zoomOut() {}, zoomWithWheel() {}, setOptions() {} };
        };
        try {
            browser.eval(browser.document.querySelector('script:not([src])').textContent);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(browser.document.querySelector('#scene text')?.textContent, '正文输出');
            assert.equal(messages.some(message => message.type === 'error'), false);
            assert.equal(messages.some(message => message.type === (fullscreen ? 'scale' : 'previewHeight')), true);
            if (fullscreen) assert.equal(typeof browser.__pawsMermaid?.reset, 'function');
            console.log(`PASS Hermes-generated ${fullscreen ? 'fullscreen' : 'inline'} HTML renders and posts its ready state (dependency stubs)`);
        } finally { browser.close(); }
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
