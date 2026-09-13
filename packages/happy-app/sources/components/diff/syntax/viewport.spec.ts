import { describe, expect, it, vi } from 'vitest';
import { SyntaxViewport } from './viewport';
vi.mock('./shared', () => ({ diffSyntax: {} }));

describe('syntax viewability', () => {
    it('notifies only cells whose visibility changes; repeating an event does nothing', () => {
        const viewport = new SyntaxViewport();
        const a = vi.fn();
        const b = vi.fn();
        const unsubscribe = viewport.subscribe('a', a);
        viewport.subscribe('b', b);
        const event = { viewableItems: [{ key: 'a', isViewable: true }] };
        viewport.update(event);
        expect(viewport.priority('a')).toBe(2);
        expect(viewport.priority('b')).toBe(1);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
        viewport.update(event);
        expect(a).toHaveBeenCalledTimes(1);
        unsubscribe();
        viewport.update({ viewableItems: [{ key: 'b', isViewable: true }] });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        expect(viewport.priority('a')).toBe(1);
    });
});