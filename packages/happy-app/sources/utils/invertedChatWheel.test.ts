import { describe, expect, it, vi } from 'vitest';
import { handleInvertedChatWheel } from './invertedChatWheel';

function element(overrides: Partial<HTMLElement> = {}, style: Partial<CSSStyleDeclaration> = {}) {
    return Object.assign({
        nodeType: 1,
        scrollTop: 100,
        scrollHeight: 1200,
        clientHeight: 400,
        scrollWidth: 300,
        clientWidth: 300,
        style: { overflowX: 'visible', overflowY: 'visible', overscrollBehaviorY: 'auto', lineHeight: '20px', fontSize: '16px', ...style },
        ownerDocument: { defaultView: { getComputedStyle: (target: HTMLElement) => target.style } },
    }, overrides) as unknown as HTMLElement;
}

function wheel(node: HTMLElement, overrides: Partial<WheelEvent> = {}, children: EventTarget[] = []) {
    return {
        deltaX: 0, deltaY: 25, deltaMode: 0,
        ctrlKey: false, metaKey: false, shiftKey: false,
        cancelable: true, defaultPrevented: false,
        preventDefault: vi.fn(), composedPath: () => [...children, node],
        ...overrides,
    } as unknown as WheelEvent;
}

describe('handleInvertedChatWheel', () => {
    it.each([25, -25, 0.75, -0.75])('corrects a pixel delta of %s toward the expected end', (deltaY) => {
        const node = element();
        const event = wheel(node, { deltaY });
        expect(handleInvertedChatWheel(node, event)).toBe(true);
        expect(node.scrollTop).toBe(100 - deltaY);
        expect(event.preventDefault).toHaveBeenCalledOnce();
    });

    it.each([
        { ctrlKey: true }, { defaultPrevented: true },
        { cancelable: false }, { deltaY: 0 }, { deltaY: NaN },
        { deltaY: Infinity }, { deltaX: 30, deltaY: 5 }, { deltaMode: 3 },
    ])('leaves gestures it does not own untouched: %j', (overrides) => {
        const node = element();
        const event = wheel(node, overrides);
        expect(handleInvertedChatWheel(node, event)).toBe(false);
        expect(node.scrollTop).toBe(100);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('corrects both forms of Shift+wheel consistently', () => {
        for (const deltas of [{ deltaX: 25, deltaY: 0 }, { deltaX: 0, deltaY: 25 }]) {
            const node = element();
            expect(handleInvertedChatWheel(node, wheel(node, { ...deltas, shiftKey: true }))).toBe(true);
            expect(node.scrollTop).toBe(75);
        }
    });

    it('still corrects Cmd+wheel, which is not the browser pinch/zoom signal', () => {
        const node = element();
        expect(handleInvertedChatWheel(node, wheel(node, { metaKey: true }))).toBe(true);
        expect(node.scrollTop).toBe(75);
    });

    it.each([
        { deltaMode: 1, deltaY: 2, expected: 60 },
        { deltaMode: 2, deltaY: -1, expected: 500 },
    ])('normalizes line/page units: %j', ({ expected, ...deltas }) => {
        const node = element();
        handleInvertedChatWheel(node, wheel(node, deltas));
        expect(node.scrollTop).toBe(expected);
    });

    it('uses font metrics when line-height is normal', () => {
        const node = element({}, { lineHeight: 'normal', fontSize: '10px' });
        handleInvertedChatWheel(node, wheel(node, { deltaMode: 1, deltaY: 2 }));
        expect(node.scrollTop).toBe(76);
    });

    it.each([{ scrollTop: 0, deltaY: 25, expected: 0 }, { scrollTop: 800, deltaY: -25, expected: 800 }])('does not bounce at a chat boundary: %j', ({ deltaY, expected, scrollTop }) => {
        const node = element({ scrollTop });
        const event = wheel(node, { deltaY });
        expect(handleInvertedChatWheel(node, event)).toBe(true);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(node.scrollTop).toBe(expected);
    });

    it.each(['auto', 'scroll'])('preserves nested vertical %s scrolling through a non-scrollable child target', (overflowY) => {
        const node = element();
        const child = element({}, { overflowY });
        const event = wheel(node, {}, [element(), child]);
        expect(handleInvertedChatWheel(node, event)).toBe(false);
        expect(node.scrollTop).toBe(100);
        expect(child.scrollTop).toBe(100);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it.each(['contain', 'none'])('honors a nested %s boundary', (overscrollBehaviorY) => {
        const node = element();
        const child = element({ scrollTop: 800 }, { overflowY: 'auto', overscrollBehaviorY });
        expect(handleInvertedChatWheel(node, wheel(node, {}, [child]))).toBe(false);
        expect(node.scrollTop).toBe(100);
    });

    it.each([{ scrollTop: 800, deltaY: 25 }, { scrollTop: 0, deltaY: -25 }])('chains from an auto-overflow child edge: %j', ({ scrollTop, deltaY }) => {
        const node = element();
        const child = element({ scrollTop }, { overflowY: 'auto' });
        expect(handleInvertedChatWheel(node, wheel(node, { deltaY }, [child]))).toBe(true);
        expect(node.scrollTop).toBe(100 - deltaY);
    });

    it.each(['auto', 'contain', 'none'])('respects %s overscroll when a child has no scroll range', (overscrollBehaviorY) => {
        const node = element();
        const child = element({ scrollTop: 0, scrollHeight: 400 }, { overflowY: 'auto', overscrollBehaviorY });
        const event = wheel(node, {}, [child]);
        expect(handleInvertedChatWheel(node, event)).toBe(overscrollBehaviorY === 'auto');
        expect(node.scrollTop).toBe(overscrollBehaviorY === 'auto' ? 75 : 100);
    });

    it('ignores hidden overflow as a native wheel owner', () => {
        const node = element();
        const child = element({}, { overflowY: 'hidden' });
        expect(handleInvertedChatWheel(node, wheel(node, {}, [child]))).toBe(true);
    });

    it.each([{ deltaX: 25, deltaY: 0 }, { deltaX: 0, deltaY: 25 }])('preserves Shift+wheel for nested horizontal content: %j', (deltas) => {
        const node = element();
        const child = element({ scrollWidth: 900 }, { overflowX: 'auto' });
        const event = wheel(node, { ...deltas, shiftKey: true }, [child]);
        expect(handleInvertedChatWheel(node, event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('allows ordinary vertical movement over horizontal-only code or table content', () => {
        const node = element();
        const child = element({ scrollWidth: 900, scrollHeight: 100 }, { overflowX: 'auto' });
        expect(handleInvertedChatWheel(node, wheel(node, {}, [child]))).toBe(true);
    });

    it('does not act on an event from outside the list', () => {
        const node = element();
        expect(handleInvertedChatWheel(node, wheel(node, { composedPath: () => [] }))).toBe(false);
    });
});