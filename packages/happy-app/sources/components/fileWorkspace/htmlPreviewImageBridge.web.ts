/** Runs inside the opaque preview frame; only the host resolves and reads files. */
function installHtmlPreviewImageBridge(channel: string) {
    type Pending = { id: number; reference: string; targets: Set<Element>; sent: boolean };
    const byReference = new Map<string, Pending>();
    const byId = new Map<number, Pending>();
    const queue: Pending[] = [];
    const current = new WeakMap<Element, { id: number; reference: string }>();
    let sequence = 0, active = 0, disposed = false;
    const attribute = (element: Element) => element.tagName === 'IMG' ? 'src' : element.tagName === 'VIDEO' ? 'poster' : null;
    const dispatchQueued = () => {
        // Drain only when DOM changes or a response releases a slot; no timers.
        while (!disposed && active < 16 && queue.length) {
            const pending = queue.shift()!;
            pending.sent = true;
            active++;
            window.parent.postMessage({ type: 'paws-preview-image-request', channel, id: pending.id, reference: pending.reference }, '*');
        }
    };

    const observeElement = (element: Element, explicitChange = false) => {
        const name = attribute(element);
        if (!name) return;
        const reference = element.getAttribute(name);
        const previous = current.get(element);
        if (previous && previous.reference === reference && !explicitChange) return;
        if (previous) byId.get(previous.id)?.targets.delete(element);
        if (!reference?.trim() || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(reference.trim())) {
            current.delete(element);
            return;
        }
        let pending = byReference.get(reference);
        const fresh = !pending;
        if (!pending) {
            pending = { id: ++sequence, reference, targets: new Set(), sent: false };
            byReference.set(reference, pending);
            byId.set(pending.id, pending);
        }
        current.set(element, { id: pending.id, reference });
        pending.targets.add(element);
        if (fresh) {
            queue.push(pending);
            dispatchQueued();
        }
    };
    const observeTree = (node: Node) => {
        if (node instanceof Element) observeElement(node);
        if (node instanceof Element || node instanceof Document) node.querySelectorAll('img[src], video[poster]').forEach(element => observeElement(element));
    };
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes' && mutation.target instanceof Element) {
                // Only a site's own assignment can retry a failed reference.
                // Our data-URL assignment is ignored by observeElement.
                if (attribute(mutation.target) === mutation.attributeName) observeElement(mutation.target, true);
            } else for (const node of mutation.addedNodes) observeTree(node);
        }
    });
    const onResponse = (event: MessageEvent) => {
        if (event.source !== window.parent) return;
        const value = event.data;
        if (!value || typeof value !== 'object' || value.type !== 'paws-preview-image-response' || value.channel !== channel || !Number.isSafeInteger(value.id)) return;
        const pending = byId.get(value.id);
        if (!pending?.sent) return;
        if (value.url !== undefined && (typeof value.url !== 'string' || !/^data:/i.test(value.url))) return;
        byId.delete(pending.id);
        byReference.delete(pending.reference);
        for (const element of pending.targets) {
            const name = attribute(element);
            const state = current.get(element);
            // A source can change before its MutationObserver record is delivered.
            if (!name || !element.isConnected || state?.id !== pending.id || element.getAttribute(name) !== state.reference) continue;
            if (value.url) element.setAttribute(name, value.url);
        }
        // Failed references stay in current, preventing retries from tree scans.
        pending.targets.clear();
        active--;
        dispatchQueued();
    };
    window.addEventListener('message', onResponse);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'poster'] });
    observeTree(document);
    window.addEventListener('pagehide', () => {
        disposed = true;
        observer.disconnect();
        queue.length = 0;
        byReference.clear();
        byId.clear();
        window.removeEventListener('message', onResponse);
    }, { once: true });
}

/** Self-contained source runs before artifact scripts create their image DOM. */
export function createHtmlPreviewImageBridgeScript(channel: string): string {
    return `(${installHtmlPreviewImageBridge.toString()})(${JSON.stringify(channel).replace(/</g, '\\u003c')});`;
}
