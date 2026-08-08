import { describe, it, expect, beforeEach } from 'vitest';
import { imageViewer, useImageViewerStore } from './imageViewer';

describe('imageViewer store', () => {
    beforeEach(() => {
        useImageViewerStore.setState({ visible: false, sources: [], index: 0 });
    });

    it('starts hidden with no sources', () => {
        const s = useImageViewerStore.getState();
        expect(s.visible).toBe(false);
        expect(s.sources).toEqual([]);
        expect(s.index).toBe(0);
    });

    it('open() with a single source wraps it into a one-item gallery', () => {
        imageViewer.open({ uri: 'file:///a.png', width: 100, height: 200 });
        const s = useImageViewerStore.getState();
        expect(s.visible).toBe(true);
        expect(s.sources).toEqual([{ uri: 'file:///a.png', width: 100, height: 200 }]);
        expect(s.index).toBe(0);
    });

    it('open() with an array + index focuses the tapped image', () => {
        imageViewer.open(
            [{ uri: 'file:///a.png' }, { uri: 'file:///b.png' }, { uri: 'file:///c.png' }],
            2,
        );
        const s = useImageViewerStore.getState();
        expect(s.visible).toBe(true);
        expect(s.sources).toHaveLength(3);
        expect(s.index).toBe(2);
    });

    it('open() clamps an out-of-range index into bounds', () => {
        imageViewer.open([{ uri: 'file:///a.png' }, { uri: 'file:///b.png' }], 9);
        expect(useImageViewerStore.getState().index).toBe(1);
    });

    it('open() ignores an empty array', () => {
        imageViewer.open([]);
        const s = useImageViewerStore.getState();
        expect(s.visible).toBe(false);
        expect(s.sources).toEqual([]);
    });

    it('close() hides but keeps sources so the image does not flash away mid-animation', () => {
        imageViewer.open({ uri: 'file:///a.png' });
        imageViewer.close();
        const s = useImageViewerStore.getState();
        expect(s.visible).toBe(false);
        expect(s.sources).toEqual([{ uri: 'file:///a.png' }]);
    });

    it('clear() releases gallery references after dismissal without clearing a reopened viewer', () => {
        imageViewer.open([{ uri: 'file:///a.png' }, { uri: 'file:///b.png' }], 1);
        imageViewer.close();
        imageViewer.clear();
        expect(useImageViewerStore.getState()).toMatchObject({
            visible: false,
            sources: [],
            index: 0,
        });

        imageViewer.open({ uri: 'file:///new.png' });
        imageViewer.clear();
        expect(useImageViewerStore.getState().sources).toEqual([{ uri: 'file:///new.png' }]);
    });

    it('open() replaces a previous gallery', () => {
        imageViewer.open({ uri: 'file:///a.png' });
        imageViewer.open([{ uri: 'file:///b.png' }, { uri: 'file:///c.png' }], 1);
        const s = useImageViewerStore.getState();
        expect(s.sources.map((x) => x.uri)).toEqual(['file:///b.png', 'file:///c.png']);
        expect(s.index).toBe(1);
    });
});
