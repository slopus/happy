import { describe, expect, it, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
// @ts-expect-error jsdom is a test-only runtime without optional declarations.
import { JSDOM } from 'jsdom';
import { createMermaidRuntime, type MermaidEngine } from './mermaidRuntime';
import { createMermaidThemeConfig } from './mermaidRendererModel';

const light = createMermaidThemeConfig({ dark: false, colors: { text: '#222222', textSecondary: '#555555', surface: '#ffffff', surfaceHigh: '#eeeeee', surfaceHighest: '#dddddd', surfacePressed: '#cccccc', divider: '#cccccc' } });
const dark = createMermaidThemeConfig({ dark: true, colors: { text: '#eeeeee', textSecondary: '#aaaaaa', surface: '#111111', surfaceHigh: '#222222', surfaceHighest: '#333333', surfacePressed: '#444444', divider: '#444444' } });

function engine(render = vi.fn(async (_id: string, _source: string) => ({ svg: '<svg />' }))) {
    return { initialize: vi.fn<(config: any) => void>(), registerLayoutLoaders: vi.fn<(layouts: any[]) => void>(), render } satisfies MermaidEngine;
}

// Exercise our renderer-extension boundary with real SVG elements. The official
// layout is the external operation; its completed geometry is hand-checked here.
async function chainLayout(options: { length?: number; branch?: boolean; group?: boolean; cycle?: boolean; direction?: string; tall?: boolean; shape?: string; reverseNodes?: boolean; minified?: boolean; labelWidth?: number; labelIndex?: number; arrowStart?: string; arrowEnd?: string } = {}) {
    const realm = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><g class="nodes"/><g class="edgePaths"/><g class="edgeLabels"/></svg>', { runScripts: 'outside-only' });
    const doc = realm.window.document, svg = doc.querySelector('svg');
    const length = options.length || 11;
    const graph: any = { direction: options.direction || 'TB', nodes: Array.from({ length }, (_, i) => ({ id: 'n' + i, shape: options.shape || 'rect', width: i < 2 ? 268 : 200, height: i < 2 ? 69 : 60 })), edges: Array.from({ length: length - 1 }, (_, i) => ({ id: 'e' + i, start: 'n' + i, end: 'n' + (i + 1), type: 'arrow_point', label: i === (options.labelIndex ?? 2) ? '确认' : '' })) };
    if (options.group) graph.nodes[0].isGroup = true;
    if (options.branch) graph.edges.push({ id: 'branch', start: 'n0', end: 'n2' });
    if (options.cycle) graph.edges[length - 2].end = 'n0';
    if (options.reverseNodes) graph.nodes.reverse();
    const official = { async render(input: any, _svg: any, helpers: any) {
        for (const node of input.nodes) {
            const selection = await helpers.insertNode(null, node);
            // Mermaid's shape helper canonicalizes rect to squareRect in place.
            if (node.shape === 'rect') node.shape = 'squareRect';
            selection.attr('transform', 'translate(140,' + (40 + Number(node.id.slice(1)) * (options.tall === false ? 40 : 120)) + ')');
        }
        for (const edge of input.edges) {
            await helpers.insertEdgeLabel(null, { ...edge, width: 0, height: 0 });
            helpers.insertEdge(null, { ...edge, arrowTypeStart: options.arrowStart || 'arrow_open', arrowTypeEnd: options.arrowEnd || 'arrow_point', points: [{ x: 140, y: 80 }, { x: 140, y: 120 }] });
        }
    } };
    const mermaid = engine();
    let factory = createMermaidRuntime;
    if (options.minified) {
        const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('./mermaidRuntime.ts', import.meta.url))], bundle: true, write: false, format: 'iife', globalName: 'runtimeExports', minify: true, target: 'es2017' }).outputFiles[0].text;
        const bundleRealm = new JSDOM('', { runScripts: 'outside-only' });
        try { factory = realm.window.eval('(' + bundleRealm.window.eval(bundle + ';runtimeExports.createMermaidRuntime.toString()') + ')'); }
        finally { bundleRealm.window.close(); }
    }
    factory(mermaid, async () => [{ name: 'elk', loader: async () => official }]);
    const layout = await mermaid.registerLayoutLoaders.mock.calls[0][0][0].loader();
    const selection = (element: any) => ({ node: () => element, attr(name: string, value: string) { element.setAttribute(name, value); return this; } });
    const markers: any = { attr: () => markers, selectAll: () => markers, style: () => markers };
    const element = (name: string) => doc.createElementNS('http://www.w3.org/2000/svg', name);
    await layout.render(graph, { node: () => svg, selectAll: () => markers }, {
        async insertNode(_parent: any, node: any) {
            const group: any = element('g'); group.setAttribute('id', node.id); group.classList.add('node');
            group.getBBox = () => ({ x: -node.width / 2, y: -node.height / 2, width: node.width, height: node.height });
            svg.querySelector('.nodes').append(group); return selection(group);
        },
        insertEdge(_parent: any, edge: any) {
            const path = element('path'); path.setAttribute('data-id', edge.id); path.setAttribute('d', 'M140,80L140,116');
            path.setAttribute('marker-end', 'url(#pointEnd)'); path.setAttribute('class', 'flowchart-link edge-pattern-dotted');
            if (options.arrowStart) path.setAttribute('marker-start', 'url(#' + options.arrowStart + ')');
            if (options.arrowEnd) path.setAttribute('marker-end', 'url(#' + options.arrowEnd + ')');
            svg.querySelector('.edgePaths').append(path);
        },
        async insertEdgeLabel(_parent: any, edge: any) {
            const outer = element('g'); outer.classList.add('edgeLabel'); outer.setAttribute('transform', 'translate(140,100)');
            const inner = element('g'); inner.classList.add('label'); inner.setAttribute('data-id', edge.id); inner.setAttribute('transform', 'translate(0,-9)');
            const content: any = element('g'); content.getBBox = () => ({ x: -(options.labelWidth || 52) / 2, y: -4, width: options.labelWidth || 52, height: 26 });
            inner.append(content); outer.append(inner); svg.querySelector('.edgeLabels').append(outer); return content;
        },
    });
    return { graph, svg, close: () => realm.window.close() };
}

describe('long single-chain folding', () => {
    it('folds a tall chain in topology order without changing measured nodes, labels, or arrows', async () => {
        const { graph, svg, close } = await chainLayout({ reverseNodes: true });
        try {
            expect(svg.querySelector('#n0').getAttribute('transform')).toBe('translate(166,66.5)');
            expect(svg.querySelector('#n1').getAttribute('transform')).toBe('translate(522,66.5)');
            expect(svg.querySelector('#n2').getAttribute('transform')).toBe('translate(844,66.5)');
            expect(svg.querySelector('#n3').getAttribute('transform')).toBe('translate(844,219)');
            expect(svg.querySelector('#n5').getAttribute('transform')).toBe('translate(166,219)');
            expect(svg.querySelector('#n6').getAttribute('transform')).toBe('translate(166,367)');
            expect(svg.querySelector('#n10').getAttribute('transform')).toBe('translate(522,515)');
            expect(svg.querySelector('path[data-id="e2"]').getAttribute('d')).toBe('M844,96.5L844,183');
            expect(svg.querySelector('.edgeLabel:has([data-id="e2"])').getAttribute('transform')).toBe('translate(844,142.75)');
            expect(svg.querySelector('.label[data-id="e2"]').getAttribute('transform')).toBe('translate(0,-9)');
            expect(svg.querySelector('path[data-id="e0"]').getAttribute('marker-end')).toBe('url(#pointEnd)');
            expect(svg.querySelector('path[data-id="e0"]').classList.contains('edge-pattern-dotted')).toBe(true);
            expect(graph.nodes.find((n: any) => n.id === 'n0').width).toBe(268);
            expect(graph.edges[2].label).toBe('确认');
        } finally { close(); }
    });

    it.each([{ branch: true }, { group: true }, { cycle: true }, { direction: 'LR' }, { tall: false }, { length: 4 }, { shape: 'circle' }])('leaves unsupported or already-short diagrams at official ELK geometry: %j', async options => {
        const { svg, close } = await chainLayout(options);
        try {
            expect(svg.querySelector('#n0').getAttribute('transform')).toBe('translate(140,40)');
            expect(svg.querySelector('path[data-id="e0"]').getAttribute('d')).toBe('M140,80L140,116');
        } finally { close(); }
    });

    it('keeps the folding logic runnable after minified factory serialization into WebView', async () => {
        const { svg, close } = await chainLayout({ minified: true });
        try { expect(svg.querySelector('#n3').getAttribute('transform')).toBe('translate(844,219)'); }
        finally { close(); }
    });

    it.each([
        { start: 'arrow_point', end: 'arrow_point', want: 'M306,66.5L382,66.5' },
        { start: 'arrow_open', end: 'arrow_circle', want: 'M300,66.5L388,66.5' },
        { start: 'arrow_cross', end: 'arrow_cross', want: 'M300,66.5L388,66.5' },
    ])('keeps both endpoint marker attributes and boundary geometry while folding: %j', async ({ start, end, want }) => {
        const { svg, close } = await chainLayout({ arrowStart: start, arrowEnd: end });
        try {
            const path = svg.querySelector('path[data-id="e0"]');
            expect(path.getAttribute('marker-start')).toBe('url(#' + start + ')');
            expect(path.getAttribute('marker-end')).toBe('url(#' + end + ')');
            expect(path.getAttribute('d')).toBe(want);
            // The second row must reverse, not retain a right-facing path.
            expect(svg.querySelector('path[data-id="e3"]').getAttribute('d')).toBe(start === 'arrow_point' ? 'M738,219L628,219' : 'M744,219L622,219');
        } finally { close(); }
    });

    it('reserves room for a wide horizontal capsule without resizing nodes', async () => {
        const { graph, svg, close } = await chainLayout({ labelIndex: 0, labelWidth: 300 });
        try {
            expect(svg.querySelector('#n0').getAttribute('transform')).toBe('translate(166,66.5)');
            expect(svg.querySelector('#n1').getAttribute('transform')).toBe('translate(766,66.5)');
            expect(svg.querySelector('.edgeLabel:has([data-id="e0"])').getAttribute('transform')).toBe('translate(466,66.5)');
            // Hand-checked label range316..616 is inside the gap300..632.
            expect(graph.nodes[0].width).toBe(268);
            expect(graph.edges[0].label).toBe('确认');
        } finally { close(); }
    });
});

describe('shared Mermaid runtime', () => {
    it('preserves standard thick-edge emphasis instead of forcing every edge to 1px', async () => {
        const mermaid = engine();
        await createMermaidRuntime(mermaid, async () => []).render('id', 'flowchart LR\nA ==> B', light);
        const css = mermaid.initialize.mock.calls[0][0].themeCSS;
        // ELK can retain both classes on the same thick edge.
        const dom = new JSDOM('<style>.edge-thickness-thick{stroke-width:3.5px}' + css + '</style><svg><g class="edgePaths"><path class="flowchart-link edge-thickness-thick edge-thickness-normal"/><path class="flowchart-link edge-thickness-normal"/></g></svg>');
        try {
            const edges = dom.window.document.querySelectorAll('path');
            expect(dom.window.getComputedStyle(edges[0]).strokeWidth).toBe('3.5px');
            expect(dom.window.getComputedStyle(edges[1]).strokeWidth).toBe('1px');
        } finally { dom.window.close(); }
    });
    it('bundles the shared runtime under Web-first platform resolution', () => {
        expect(() => buildSync({
            stdin: { contents: "export { createMermaidRuntime } from './mermaidRuntime'", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
            bundle: true, write: false, format: 'esm', resolveExtensions: ['.web.ts', '.ts', '.js'],
        })).not.toThrow();
    });
    it('serializes initialize and render across simultaneous diagrams and recovers after a failure', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const order: string[] = [];
        const mermaid: MermaidEngine = {
            initialize(config) { order.push(config.themeVariables.darkMode ? 'dark' : 'light'); },
            registerLayoutLoaders() {},
            async render(id) { order.push(id); if (id === 'first') { await gate; throw new Error('bad source'); } return { svg: id }; },
        };
        const runtime = createMermaidRuntime(mermaid, async () => []);
        const first = runtime.render('first', 'flowchart TB\nA --> B', light);
        const failed = expect(first).rejects.toThrow('bad source');
        const second = runtime.render('second', 'sequenceDiagram\nA->>B: Hi', dark);
        await Promise.resolve();
        expect(order).toEqual(['light', 'first']);
        release();
        await failed;
        expect(await second).toBe('second');
        expect(order).toEqual(['light', 'first', 'dark', 'second']);
    });

    it.each([
        'flowchart TB\nA --> B',
        'graph LR\nA --> B',
        '---\ntitle: Example\n---\n%% comment\nflowchart TB\nA --> B',
        '%%{init: {"theme":"dark"}}%%\n%% comment\ngraph TD\nA --> B',
    ])('recognizes flowcharts without rewriting their source: %s', async source => {
        const mermaid = engine();
        await createMermaidRuntime(mermaid, async () => []).render('diagram', source, light);
        expect(mermaid.render).toHaveBeenCalledWith('diagram', source);
        expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
            layout: 'paws-flowchart', htmlLabels: false, securityLevel: 'strict',
            secure: expect.arrayContaining(['layout', 'themeCSS', 'themeVariables', 'securityLevel']),
        }));
    });

    it.each(['sequenceDiagram\nA->>B: Hi', 'classDiagram\nA <|-- B', 'stateDiagram-v2\n[*] --> A'])('retains the default layout for %s', async source => {
        const mermaid = engine();
        await createMermaidRuntime(mermaid, async () => []).render('diagram', source, light);
        const config = mermaid.initialize.mock.calls[0][0];
        expect(config).not.toHaveProperty('layout');
        expect(config).not.toHaveProperty('themeCSS');
        expect(mermaid.render).toHaveBeenCalledWith('diagram', source);
    });

    it('loads official ELK lazily, caches its module, and retries a rejected import', async () => {
        const mermaid = engine();
        const loader = vi.fn(async () => ({ render: vi.fn() }));
        const load = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue([{ name: 'elk', loader }]);
        createMermaidRuntime(mermaid, load);
        expect(load).not.toHaveBeenCalled();
        const registration = mermaid.registerLayoutLoaders.mock.calls[0][0][0];
        await expect(registration.loader()).rejects.toThrow('network');
        expect((await registration.loader()).render).toBeTypeOf('function');
        await registration.loader();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('normalizes decision nodes and rectangles but preserves groups and other shapes', async () => {
        const mermaid = engine();
        let adapted: any;
        createMermaidRuntime(mermaid, async () => [{ name: 'elk', loader: async () => ({ render(_graph: any, _svg: any, helpers: any) { adapted = helpers; } }) }]);
        const layout = await mermaid.registerLayoutLoaders.mock.calls[0][0][0].loader();
        const graph = { nodes: [{ shape: 'diamond' }, { shape: 'rect', height: 80 }, { shape: 'circle' }, { shape: 'rect', isGroup: true }] };
        const markers: any = { attr: vi.fn(() => markers), selectAll: vi.fn(() => markers), style: vi.fn(() => markers) };
        const helpers = { insertEdge: vi.fn(), insertEdgeLabel: vi.fn() };
        await layout.render(graph, { selectAll: () => markers }, helpers);
        expect(graph.nodes[0]).toMatchObject({ shape: 'rect', cssClasses: ' paws-decision', height: 60, padding: 16 });
        expect(graph.nodes[1].height).toBe(80);
        expect(graph.nodes[2]).toEqual({ shape: 'circle' });
        expect(graph.nodes[3]).toEqual({ shape: 'rect', isGroup: true });
        expect(markers.attr).toHaveBeenCalledWith('d', 'M 3.2 -3.2 L 0 0 L 3.2 3.2');
        const edge = { points: [{ x: 0, y: 0 }, { x: 0, y: 20 }], arrowTypeEnd: 'arrow_point' };
        adapted.insertEdge(null, edge, 'extra');
        expect(helpers.insertEdge.mock.calls[0][1].points[1].y).toBe(14);
        expect(edge.points[1].y).toBe(20);
        expect(helpers.insertEdge.mock.calls[0][2]).toBe('extra');
    });

    it('runs the minified bundle factory in a separate WebView realm with no module closures', async () => {
        const bundle = buildSync({
            entryPoints: [fileURLToPath(new URL('./mermaidRuntime.ts', import.meta.url))],
            bundle: true, write: false, format: 'iife', globalName: 'runtimeExports', minify: true, target: 'es2017',
        }).outputFiles[0].text;
        const bundleRealm = new JSDOM('', { runScripts: 'outside-only' });
        const webView = new JSDOM('', { runScripts: 'outside-only' });
        try {
            const serialized = bundleRealm.window.eval(bundle + '\n;runtimeExports.createMermaidRuntime.toString()');
            const factory = webView.window.eval('(' + serialized + ')');
            const mermaid = engine();
            expect(await factory(mermaid, async () => []).render('id', 'flowchart TB\nA --> B', light)).toBe('<svg />');
            expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ layout: 'paws-flowchart' }));
        } finally { bundleRealm.window.close(); webView.window.close(); }
    });

    it.each([true, false])('keeps explicit fills readable in dark mode (color-mix supported: %s)', async supportsMix => {
        const realm = new JSDOM('', { runScripts: 'outside-only' });
        try {
            realm.window.CSS = { supports: (_property: string, value: string) => !value.startsWith('color-mix') || supportsMix };
            const factory = realm.window.eval('(' + createMermaidRuntime.toString() + ')');
            const svg = '<svg><g class="node"><rect class="label-container" style="fill:#e8f5e9"/><text>Text</text></g><g class="node"><rect class="label-container" style="fill:transparent"/></g></svg>';
            const mermaid = engine(vi.fn(async () => ({ svg })));
            const runtime = factory(mermaid, async () => []);
            const result = await runtime.render('id', 'flowchart TB\nA', dark);
            const doc = new JSDOM(result).window.document;
            expect(doc.querySelector('rect').style.fill).toBe(supportsMix ? 'color-mix(in oklab, #e8f5e9 22%, #111111)' : '#111111');
            expect(doc.querySelector('text').style.fill).toBe('#eeeeee');
            expect(doc.querySelectorAll('rect')[1].style.fill).toBe('transparent');
            expect(await runtime.render('light', 'flowchart TB\nA', light)).toBe(svg);
            expect(await runtime.render('sequence', 'sequenceDiagram\nA->>B: Hi', dark)).toBe(svg);
            doc.defaultView?.close();
        } finally { realm.window.close(); }
    });
});
