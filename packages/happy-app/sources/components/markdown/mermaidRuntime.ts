import type { MermaidThemeConfig } from './mermaidRendererModel';

export const MERMAID_VERSION = '11.16.0';
export const MERMAID_ELK_VERSION = '0.2.2';

// Mermaid's renderer-extension payload is not a public, stable graph model.
// Keep the untyped integration at this boundary, not in component callers.
export type MermaidEngine = {
    initialize: (config: any) => void;
    registerLayoutLoaders: (layouts: any[]) => void;
    render: (id: string, source: string) => Promise<{ svg: string }>;
};
export type MermaidRuntime = {
    render: (id: string, source: string, config: MermaidThemeConfig) => Promise<string>;
};

/**
 * Shared Web/WebView runtime. Deliberately self-contained and ES5-shaped:
 * Native embeds this function's source, so no imported values, async helpers,
 * spread helpers or module-level closures may be referenced in its body.
 * The serialization/minified-build tests protect this cross-realm contract.
 */
export function createMermaidRuntime(mermaid: MermaidEngine, loadElk: () => Promise<any[]>): MermaidRuntime {
    var layoutName = 'paws-flowchart';
    var pending: Promise<unknown> = Promise.resolve();
    var layoutPromise: Promise<any[]> | undefined;
    var rects = ['rect', 'squareRect', 'proc', 'process', 'rectangle', 'rounded', 'roundedRect', 'event'];
    var decisions = ['diamond', 'diam', 'decision', 'question'];

    function shorten(edge: any, index: number, neighbor: number, arrow: string) {
        var point = edge.points[index], next = edge.points[neighbor];
        if (arrow !== 'arrow_point' || !point || !next) return;
        var dx = next.x - point.x, dy = next.y - point.y;
        var distance = Math.hypot(dx, dy);
        if (!distance) return;
        var inset = Math.min(6, Math.max(0, distance / 2 - 4));
        edge.points[index] = { x: point.x + dx * inset / distance, y: point.y + dy * inset / distance };
    }

    // Chain-only post-layout adaptation. Keep ELK's measured shapes and all
    // original SVG styles/markers; compound, branching and cyclic graphs stay
    // entirely with official ELK. Nested here for Native factory serialization.
    function foldLongChain(graph: any, svg: any, renderedNodes: any, renderedEdges: any, renderedLabels: any) {
        if (!graph.edges || !graph.nodes || !/^(TB|TD)$/.test(graph.direction) || graph.nodes.length < 7 || graph.edges.length !== graph.nodes.length - 1) return;
        var nodes = Object.create(null), incoming = Object.create(null), outgoing = Object.create(null), invalid = false;
        graph.nodes.forEach(function(node: any) {
            if (node.isGroup || rects.indexOf(node.shape) < 0 || nodes[node.id]) invalid = true;
            nodes[node.id] = node; incoming[node.id] = 0;
        });
        graph.edges.forEach(function(edge: any) {
            if (!nodes[edge.start] || !nodes[edge.end] || outgoing[edge.start] || edge.start === edge.end || edge.startLabelLeft || edge.startLabelRight || edge.endLabelLeft || edge.endLabelRight) { invalid = true; return; }
            outgoing[edge.start] = edge; incoming[edge.end]++;
            if (incoming[edge.end] > 1) invalid = true;
        });
        var starts = graph.nodes.filter(function(node: any) { return incoming[node.id] === 0; });
        if (invalid || starts.length !== 1) return;
        var order: any[] = [], visited = Object.create(null), current = starts[0];
        while (current && !visited[current.id]) {
            visited[current.id] = true; order.push(current);
            current = outgoing[current.id] ? nodes[outgoing[current.id].end] : undefined;
        }
        if (order.length !== graph.nodes.length || current) return;
        var bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
        var sizes: any[] = [];
        order.forEach(function(node: any) {
            var element = renderedNodes[node.id];
            var translation = element && /^translate\(\s*([-+\d.eE]+)[ ,]+\s*([-+\d.eE]+)\s*\)$/.exec(element.getAttribute('transform') || '');
            if (!translation) { invalid = true; return; }
            var box = element.getBBox(), x = Number(translation[1]), y = Number(translation[2]);
            if (![box.width, box.height, x, y].every(Number.isFinite) || box.width <= 0 || box.height <= 0) { invalid = true; return; }
            sizes.push({ width: box.width, height: box.height });
            bounds.left = Math.min(bounds.left, x - box.width / 2); bounds.right = Math.max(bounds.right, x + box.width / 2);
            bounds.top = Math.min(bounds.top, y - box.height / 2); bounds.bottom = Math.max(bounds.bottom, y + box.height / 2);
        });
        var height = bounds.bottom - bounds.top, width = bounds.right - bounds.left;
        if (invalid || height < 960 || height < width * 2.5) return;
        var paths = Object.create(null);
        svg.node().querySelectorAll('.edgePaths path.flowchart-link').forEach(function(path: any) { paths[path.getAttribute('data-id')] = path; });
        graph.edges.forEach(function(edge: any) { if (!paths[edge.id] || !renderedEdges[edge.id] || !renderedLabels[edge.id] || !renderedLabels[edge.id].container) invalid = true; });
        if (invalid) return;
        var columns = [0, 0, 0], rows: number[] = [], gapX = 88, gapY = 88, padding = 32;
        function cell(index: number) { var row = Math.floor(index / 3); return { row: row, col: row % 2 ? 2 - index % 3 : index % 3 }; }
        order.forEach(function(node: any, index: number) {
            var position = cell(index), size = sizes[index];
            columns[position.col] = Math.max(columns[position.col], size.width);
            rows[position.row] = Math.max(rows[position.row] || 0, size.height);
            var label = outgoing[node.id] && renderedLabels[outgoing[node.id].id];
            if (label && label.text) { gapX = Math.max(gapX, label.width + 32); gapY = Math.max(gapY, label.height + 32); }
        });
        function centers(lengths: number[], gap: number) { var offset = padding; return lengths.map(function(length: number) { var value = offset + length / 2; offset += length + gap; return value; }); }
        var xs = centers(columns, gapX), ys = centers(rows, gapY), positions = Object.create(null);
        order.forEach(function(node: any, index: number) {
            var position = cell(index), center = { x: xs[position.col], y: ys[position.row], width: sizes[index].width, height: sizes[index].height, row: position.row };
            positions[node.id] = center;
            renderedNodes[node.id].setAttribute('transform', 'translate(' + center.x + ',' + center.y + ')');
        });
        graph.edges.forEach(function(edge: any) {
            var from = positions[edge.start], to = positions[edge.end], horizontal = from.row === to.row, direction = to.x > from.x ? 1 : -1;
            var start = horizontal ? { x: from.x + direction * from.width / 2, y: from.y } : { x: from.x, y: from.y + from.height / 2 };
            var end = horizontal ? { x: to.x - direction * to.width / 2, y: to.y } : { x: to.x, y: to.y - to.height / 2 };
            var label = renderedLabels[edge.id];
            label.container.setAttribute('transform', 'translate(' + ((start.x + end.x) / 2) + ',' + ((start.y + end.y) / 2) + ')');
            var adapted = { points: [start, end] }, metadata = renderedEdges[edge.id];
            shorten(adapted, 0, 1, metadata.arrowTypeStart); shorten(adapted, 1, 0, metadata.arrowTypeEnd);
            paths[edge.id].setAttribute('d', 'M' + adapted.points[0].x + ',' + adapted.points[0].y + 'L' + adapted.points[1].x + ',' + adapted.points[1].y);
            // ELK's diagnostic points must not describe the superseded path.
            paths[edge.id].removeAttribute('data-points');
        });
    }

    mermaid.registerLayoutLoaders([{
        name: layoutName,
        algorithm: 'elk.layered',
        loader: function() {
            if (!layoutPromise) {
                layoutPromise = loadElk().catch(function(error) { layoutPromise = undefined; throw error; });
            }
            return layoutPromise.then(function(layouts) {
                var elk = layouts.filter(function(layout: any) { return layout.name === 'elk'; })[0];
                if (!elk) throw new Error('ELK layout is unavailable');
                return elk.loader();
            }).then(function(engine: any) {
                return { render: function(graph: any, svg: any, helpers: any, options: any, context: any) {
                    var renderedNodes = Object.create(null), renderedEdges = Object.create(null), renderedLabels = Object.create(null);
                    graph.nodes.forEach(function(node: any) {
                        if (node.isGroup) return;
                        if (decisions.indexOf(node.shape) >= 0) {
                            node.shape = 'rect';
                            node.cssClasses = (node.cssClasses || '') + ' paws-decision';
                        }
                        if (rects.indexOf(node.shape) >= 0) {
                            Object.assign(node, { shape: 'rect', padding: 16, labelPaddingX: 36, height: Math.max(60, node.height || 0) });
                        }
                    });
                    var adapted = Object.assign({}, helpers, {
                        insertNode: function(selection: any, node: any) {
                            var args = Array.prototype.slice.call(arguments, 2);
                            return Promise.resolve(helpers.insertNode.apply(helpers, [selection, node].concat(args))).then(function(result: any) { renderedNodes[node.id] = result.node(); return result; });
                        },
                        insertEdge: function(selection: any, original: any) {
                            var args = Array.prototype.slice.call(arguments, 2);
                            var edge = Object.assign({}, original, { points: (original.points || []).map(function(point: any) { return Object.assign({}, point); }) });
                            renderedEdges[original.id] = original;
                            shorten(edge, 0, 1, edge.arrowTypeStart);
                            shorten(edge, edge.points.length - 1, edge.points.length - 2, edge.arrowTypeEnd);
                            return helpers.insertEdge.apply(helpers, [selection, edge].concat(args));
                        },
                        insertEdgeLabel: function(selection: any, edge: any) {
                            return Promise.resolve(helpers.insertEdgeLabel(selection, edge)).then(function(group: any) {
                                var rect = group.querySelector('rect.background'), text = group.querySelector('text');
                                if (edge.label && rect && text) {
                                    var bounds = text.getBBox(), height = Math.max(26, bounds.height + 8);
                                    rect.setAttribute('x', String(bounds.x - 12));
                                    rect.setAttribute('y', String(bounds.y - (height - bounds.height) / 2));
                                    rect.setAttribute('width', String(bounds.width + 24));
                                    rect.setAttribute('height', String(height));
                                    rect.style.removeProperty('stroke');
                                    var box = group.getBBox();
                                    edge.width = box.width; edge.height = box.height;
                                    if (group.parentElement) group.parentElement.setAttribute('transform', 'translate(' + (-box.x - box.width / 2) + ',' + (-box.y - box.height / 2) + ')');
                                }
                                var labelBox = group.getBBox();
                                renderedLabels[edge.id] = { container: group.closest('.edgeLabel'), text: edge.label, width: labelBox.width, height: labelBox.height };
                                return group;
                            });
                        },
                    });
                    return Promise.resolve(engine.render(graph, svg, adapted, options, context)).then(function() {
                        foldLongChain(graph, svg, renderedNodes, renderedEdges, renderedLabels);
                        svg.selectAll('marker[id*="-pointEnd"],marker[id*="-pointStart"]')
                            .attr('viewBox', '-5 -5 10 10').attr('markerWidth', 10).attr('markerHeight', 10).attr('refX', 0).attr('refY', 0)
                            .selectAll('path')
                            .style('fill', 'none').style('stroke-width', '1').style('stroke-dasharray', 'none')
                            .style('stroke-linecap', 'round').style('stroke-linejoin', 'round');
                        // orient="auto" follows the edge direction at both ends.
                        svg.selectAll('marker[id*="-pointEnd"] path').attr('d', 'M -3.2 -3.2 L 0 0 L -3.2 3.2');
                        svg.selectAll('marker[id*="-pointStart"] path').attr('d', 'M 3.2 -3.2 L 0 0 L 3.2 3.2');
                    });
                } };
            });
        },
    }]);

    function isFlowchart(source: string): boolean {
        var cleaned = source.replace(/^\s*---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').replace(/%%\{[\s\S]*?\}%%/g, '');
        var lines = cleaned.split(/\r?\n/).filter(function(line) { return line.trim() && !/^\s*%%/.test(line); });
        return /^\s*(?:flowchart|graph)\b/i.test(lines[0] || '');
    }

    function flowchartCss(config: MermaidThemeConfig): string {
        var c = config.themeVariables;
        return '.node text{font-size:' + c.fontSize + ';font-weight:600;fill:' + c.primaryTextColor + '}' +
            '.edgeLabels text{font-size:14px;font-weight:600;fill:' + c.primaryTextColor + '}' +
            '.node tspan[font-weight="normal"],.edgeLabels tspan[font-weight="normal"]{font-weight:600}' +
            '.node rect,.node circle,.node ellipse,.node polygon,.node path{fill:' + c.primaryColor + ';stroke:' + c.primaryBorderColor + ';stroke-width:1px}' +
            '.node rect{rx:16px;ry:16px}' +
            '.node.paws-decision .label-container{fill:' + c.secondaryColor + ';stroke:' + c.lineColor + ';stroke-dasharray:2 2}' +
            '.edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:' + c.edgeLabelBackground + ';stroke:' + c.primaryBorderColor + ';stroke-width:1px}' +
            '.edgePaths .flowchart-link{stroke:' + c.lineColor + ';stroke-linecap:round;stroke-linejoin:round}' +
            '.edgePaths .edge-thickness-normal:not(.edge-thickness-thick){stroke-width:1px}' +
            '.marker{fill:none;stroke:' + c.lineColor + '}';
    }

    function adaptDarkFill(markup: string, config: MermaidThemeConfig): string {
        if (typeof document === 'undefined') return markup;
        var template = document.createElement('template');
        template.innerHTML = markup;
        template.content.querySelectorAll<SVGElement>('.node > .label-container[style*="fill"],.node > .label-container.outer-path > path[style*="fill"]').forEach(function(node) {
            var fill = node.style.getPropertyValue('fill');
            if (!fill || fill.trim().toLowerCase() === 'transparent') return;
            if (typeof CSS === 'undefined' || !CSS.supports('color', fill)) return;
            var mix = 'color-mix(in oklab, ' + fill + ' 22%, ' + config.themeVariables.secondaryColor + ')';
            node.style.setProperty('fill', CSS.supports('color', mix) ? mix : config.themeVariables.secondaryColor, 'important');
            var parent = node.closest('.node');
            if (parent) parent.querySelectorAll<SVGElement>('text,tspan').forEach(function(text) { text.style.setProperty('fill', config.themeVariables.primaryTextColor, 'important'); });
        });
        return template.innerHTML;
    }

    return { render: function(id, source, baseConfig) {
        var operation = pending.then(function() {
            var flowchart = isFlowchart(source);
            var config = Object.assign({}, baseConfig, {
                securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true,
                secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'layout', 'theme', 'themeCSS', 'themeVariables', 'htmlLabels', 'flowchart'],
            });
            if (flowchart) Object.assign(config, { layout: layoutName, themeCSS: flowchartCss(baseConfig), flowchart: { useMaxWidth: false } });
            mermaid.initialize(config);
            return mermaid.render(id, source).then(function(result) {
                return flowchart && baseConfig.themeVariables.darkMode ? adaptDarkFill(result.svg, baseConfig) : result.svg;
            });
        });
        pending = operation.then(function() {}, function() {});
        return operation;
    } };
}
