// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWebPopoverDismiss } from './useWebPopoverDismiss';
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); document.body.replaceChildren(); });

function Fixture({ enabled = true, onDismiss }: { enabled?: boolean; onDismiss: () => void }) {
    const inside = React.useRef<HTMLDivElement>(null);
    useWebPopoverDismiss({ enabled, onDismiss, isInside: target => !!inside.current?.contains(target) });
    return <div ref={inside}><button>Option</button></div>;
}
function pointer(target: Element, button = 0) {
    // MouseEvent supplies the standard pointerdown fields in jsdom.
    act(() => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button })); });
}
function setup() {
    const host = document.createElement('div'); document.body.append(host);
    root = createRoot(host);
    return host;
}
describe('Web popover click-away', () => {
    it('ignores the panel and dismisses across layout boundaries even if bubbling is stopped', () => {
        const onDismiss = vi.fn(); const host = setup();
        act(() => root.render(<Fixture onDismiss={onDismiss} />));
        pointer(host.querySelector('button')!);
        expect(onDismiss).not.toHaveBeenCalled();
        const outside = document.createElement('button'); document.body.append(outside);
        outside.addEventListener('pointerdown', event => event.stopPropagation());
        pointer(outside);
        expect(onDismiss).toHaveBeenCalledOnce();
    });
    it('uses the latest callback and releases the listener when closed and reopened', () => {
        const first = vi.fn(), latest = vi.fn(); setup();
        act(() => root.render(<Fixture onDismiss={first} />));
        act(() => root.render(<Fixture onDismiss={latest} />));
        pointer(document.body, 2);
        expect(latest).not.toHaveBeenCalled();
        pointer(document.body);
        expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce();
        act(() => root.render(<Fixture enabled={false} onDismiss={latest} />));
        pointer(document.body); expect(latest).toHaveBeenCalledOnce();
        act(() => root.render(<Fixture onDismiss={latest} />));
        pointer(document.body); expect(latest).toHaveBeenCalledTimes(2);
        act(() => root.unmount()); root = undefined as any;
        pointer(document.body); expect(latest).toHaveBeenCalledTimes(2);
    });
});
