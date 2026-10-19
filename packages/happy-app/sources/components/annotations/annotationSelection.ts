import type { AnnotationSelection, MessageAnnotation } from './annotationDraft';

/** Handles both Text and Element boundaries and selections across inline Markdown. */
export function readAnnotationSelection(root: HTMLElement, messageId: string, selection: Selection | null): (AnnotationSelection & { rect: DOMRect }) | null {
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const element = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    if ([element(range.startContainer), element(range.endContainer)].some(el => el?.closest('button,textarea,input,[contenteditable="true"],[data-no-annotation]'))) return null;
    const quote = selection.toString().trim();
    const anchorText = range.toString();
    if (!quote || !anchorText) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    return { messageId, quote, anchorText, start, end: start + anchorText.length, rect: range.getBoundingClientRect() };
}

/** Rebuild a Range after React remounts; identical text elsewhere is not a match. */
export function annotationRange(root: HTMLElement, annotation: MessageAnnotation): Range | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let offset = 0;
    let start: { node: Node; offset: number } | undefined;
    let end: { node: Node; offset: number } | undefined;
    while ((node = walker.nextNode())) {
        const length = node.textContent?.length ?? 0;
        if (!start && annotation.start < offset + length) start = { node, offset: annotation.start - offset };
        if (annotation.end <= offset + length) { end = { node, offset: annotation.end - offset }; break; }
        offset += length;
    }
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range.toString() === annotation.anchorText ? range : null;
}
