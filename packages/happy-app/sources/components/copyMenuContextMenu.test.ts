import { describe, expect, it, vi } from 'vitest';
import { handleCopyMenuContextMenu } from './copyMenuContextMenu';

describe('handleCopyMenuContextMenu', () => {
    it('prevents the browser menu and opens the custom menu at the cursor point', () => {
        const preventDefault = vi.fn();
        const onOpen = vi.fn();

        handleCopyMenuContextMenu({
            preventDefault,
            nativeEvent: {
                pageX: 144,
                pageY: 288,
            },
        }, onOpen);

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledWith({ pageX: 144, pageY: 288 });
    });
});
