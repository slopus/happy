/** Mermaid emits HTML void tags inside foreignObject; an SVG image requires valid XML. */
export function createMermaidImageUri(svg: string): string {
    const document = new DOMParser().parseFromString(svg, 'text/html');
    const element = document.querySelector('svg');
    if (!element) throw new Error('Mermaid did not render an SVG');
    // HTML-parsed XHTML xmlns attributes lack the XMLNS namespace. Let the
    // serializer declare each element's actual namespace without duplicate attributes.
    for (const node of [element, ...element.querySelectorAll('[xmlns]')]) {
        node.removeAttribute('xmlns');
    }
    const dimensions = element.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (dimensions?.length === 4 && dimensions.every(Number.isFinite) && dimensions[2] > 0 && dimensions[3] > 0) {
        element.setAttribute('width', String(dimensions[2]));
        element.setAttribute('height', String(dimensions[3]));
    }
    const serialized = new XMLSerializer().serializeToString(element);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
}
