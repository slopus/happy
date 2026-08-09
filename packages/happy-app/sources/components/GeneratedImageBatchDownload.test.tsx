import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer does not publish TypeScript declarations in this workspace.
// @ts-expect-error The test only uses create, find and unmount.
import TestRenderer from 'react-test-renderer';

import { GeneratedImageBatchDownload } from './GeneratedImageBatchDownload';
import type { ImageBatchDownloadItem, ImageBatchDownloadResult } from '@/utils/imageBatchDownload';

const mocks = vi.hoisted(() => ({
    downloadImageBatch: vi.fn(),
    alert: vi.fn(),
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: (theme: object) => object) => factory({
            colors: {
                accent: '#4f46e5',
                accentContrast: '#ffffff',
                divider: '#333333',
                surface: '#181818',
                surfaceHigh: '#222222',
                surfacePressed: '#2a2a2a',
                text: '#ffffff',
                textSecondary: '#888888',
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: '#4f46e5',
                accentContrast: '#ffffff',
                divider: '#333333',
                surface: '#181818',
                surfaceHigh: '#222222',
                surfacePressed: '#2a2a2a',
                text: '#ffffff',
                textSecondary: '#888888',
            },
        },
    }),
}));
vi.mock('@/utils/imageBatchDownload', () => ({
    downloadImageBatch: mocks.downloadImageBatch,
}));
vi.mock('@/modal', () => ({
    Modal: { alert: mocks.alert },
}));
vi.mock('@/text', () => ({
    t: (key: string, params: Record<string, number> = {}) => {
        switch (key) {
            case 'generatedImageBatchDownload.preparing':
                return `Preparing ${params.ready}/${params.total}`;
            case 'generatedImageBatchDownload.downloadAll':
                return `Download all ${params.count}`;
            case 'generatedImageBatchDownload.downloading':
                return `Downloading ${params.completed}/${params.total}`;
            case 'generatedImageBatchDownload.saved':
                return `Saved ${params.count}`;
            case 'generatedImageBatchDownload.savedBrowser':
                return `${params.count} downloads started · Allow multiple downloads if your browser asks`;
            case 'generatedImageBatchDownload.savedDirectory':
                return `Saved ${params.count} to the selected folder`;
            case 'generatedImageBatchDownload.savedPhotos':
                return `Saved ${params.count} to Photos`;
            case 'generatedImageBatchDownload.cancelledBrowser':
                return 'Downloads cancelled · Try again and allow multiple downloads';
            case 'generatedImageBatchDownload.cancelledDirectory':
                return 'No folder selected · Choose a folder to save the images';
            case 'generatedImageBatchDownload.cancelledPhotos':
                return 'Photos access is required to save generated images';
            case 'generatedImageBatchDownload.cancelledUnsupported':
                return 'Batch download is not available on this platform';
            case 'generatedImageBatchDownload.partial':
                return `Saved ${params.succeeded}; ${params.failed} failed`;
            case 'generatedImageBatchDownload.retryFailed':
                return `Retry ${params.count}`;
            default:
                return key;
        }
    },
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

function result(overrides: Partial<ImageBatchDownloadResult> = {}): ImageBatchDownloadResult {
    return {
        succeeded: [],
        failed: [],
        cancelled: false,
        destination: 'photos',
        ...overrides,
    };
}

function readyItems(count: number, prefix = 'image'): ImageBatchDownloadItem[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index + 1}`,
        uri: `data:image/png;base64,${index + 1}`,
        filename: `${prefix}-${index + 1}.png`,
    }));
}

describe('GeneratedImageBatchDownload', () => {
    beforeEach(() => {
        mocks.downloadImageBatch.mockReset();
        mocks.alert.mockReset();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('keeps the batch action disabled until every expected image settles', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={[{ id: 'a', uri: 'data:image/png;base64,AA==', filename: 'a.png' }]}
                    displayedCount={2}
                    settledCount={1}
                    pendingCount={54}
                />,
            );
        });

        const button = renderer.root.findByProps({ testID: 'attachment-gallery-download-all' });
        expect(button.props.disabled).toBe(true);
        expect(button.findByType('Text').children.join('')).toContain('1/56');

        act(() => renderer.unmount());
    });

    it('uses semantic surfaces for resting and pressed states', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={readyItems(2)}
                    displayedCount={2}
                    settledCount={2}
                    pendingCount={0}
                />,
            );
        });

        const button = renderer.root.findByProps({ testID: 'attachment-gallery-download-all' });
        expect(button.props.style({ pressed: false })[1].backgroundColor).toBe('#181818');
        expect(button.props.style({ pressed: true })[1].backgroundColor).toBe('#2a2a2a');

        act(() => button.props.onHoverIn());
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' })
            .props.style({ pressed: false })[1].backgroundColor).toBe('#2a2a2a');
        act(() => renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onHoverOut());
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' })
            .props.style({ pressed: false })[1].backgroundColor).toBe('#181818');

        act(() => renderer.unmount());
    });

    it('uses the per-batch AsyncLock to deduplicate simultaneous owners', async () => {
        const items = readyItems(2, 'shared');
        const pendingDownload = deferred<ImageBatchDownloadResult>();
        mocks.downloadImageBatch.mockReturnValue(pendingDownload.promise);

        let firstRenderer: any;
        let secondRenderer: any;
        act(() => {
            firstRenderer = TestRenderer.create(
                <GeneratedImageBatchDownload items={items} displayedCount={2} settledCount={2} pendingCount={0} />,
            );
            secondRenderer = TestRenderer.create(
                <GeneratedImageBatchDownload items={items} displayedCount={2} settledCount={2} pendingCount={0} />,
            );
        });

        act(() => {
            firstRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onPress();
            secondRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(mocks.downloadImageBatch).toHaveBeenCalledTimes(1);

        await act(async () => {
            pendingDownload.resolve(result({ succeeded: items.map((item) => item.id) }));
            await pendingDownload.promise;
            await Promise.resolve();
        });
        act(() => {
            firstRenderer.unmount();
            secondRenderer.unmount();
        });
    });

    it('guards duplicate presses and retries only failed images', async () => {
        const items = readyItems(56);
        const firstDownload = deferred<ImageBatchDownloadResult>();
        const retryDownload = deferred<ImageBatchDownloadResult>();
        mocks.downloadImageBatch
            .mockReturnValueOnce(firstDownload.promise)
            .mockReturnValueOnce(retryDownload.promise);

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={items}
                    displayedCount={56}
                    settledCount={56}
                    pendingCount={0}
                />,
            );
        });

        const button = renderer.root.findByProps({ testID: 'attachment-gallery-download-all' });
        expect(button.props.disabled).toBe(false);

        let firstDownloadPromise!: Promise<void>;
        act(() => {
            firstDownloadPromise = button.props.onPress();
            void button.props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(mocks.downloadImageBatch).toHaveBeenCalledTimes(1);
        expect(mocks.downloadImageBatch.mock.calls[0][0]).toEqual(
            items.map((item, index) => ({ ...item, ordinal: index + 1 })),
        );

        act(() => {
            mocks.downloadImageBatch.mock.calls[0][1].onProgress({
                completed: 31,
                total: 56,
                succeeded: 31,
                failed: 0,
                currentId: 'image-31',
            });
        });
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' })
            .findByType('Text').children.join('')).toContain('31/56');

        await act(async () => {
            firstDownload.resolve(result({
                succeeded: items.slice(0, 55).map((item) => item.id),
                failed: [{ id: 'image-56', error: new Error('write failed') }],
            }));
            await firstDownloadPromise;
        });

        const summaryText = renderer.root.findByProps({ testID: 'attachment-gallery-download-summary' })
            .findAllByType('Text')
            .map((node: any) => node.children.join(''));
        expect(summaryText).toContain('Saved 55; 1 failed');
        const retryButton = renderer.root.findByProps({ testID: 'attachment-gallery-download-retry' });

        let retryDownloadPromise!: Promise<void>;
        act(() => {
            retryDownloadPromise = retryButton.props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(mocks.downloadImageBatch).toHaveBeenCalledTimes(2);
        expect(mocks.downloadImageBatch.mock.calls[1][0]).toEqual([{ ...items[55], ordinal: 56 }]);

        await act(async () => {
            retryDownload.resolve(result({ succeeded: ['image-56'] }));
            await retryDownloadPromise;
        });
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-summary' })
            .findByType('Text').children.join('')).toBe('Saved 56 to Photos');
        expect(renderer.root.findAllByProps({ testID: 'attachment-gallery-download-retry' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('retains failed items when a retry destination is cancelled', async () => {
        const items = readyItems(2, 'cancel-retry');
        mocks.downloadImageBatch
            .mockResolvedValueOnce(result({
                succeeded: ['cancel-retry-1'],
                failed: [{ id: 'cancel-retry-2', error: new Error('write failed') }],
            }))
            .mockResolvedValueOnce(result({ cancelled: true, destination: 'photos' }));

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <GeneratedImageBatchDownload items={items} displayedCount={2} settledCount={2} pendingCount={0} />,
            );
        });
        act(() => renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onPress());
        await act(async () => {
            for (let index = 0; index < 4; index += 1) await Promise.resolve();
        });

        act(() => renderer.root.findByProps({ testID: 'attachment-gallery-download-retry' }).props.onPress());
        await act(async () => {
            for (let index = 0; index < 4; index += 1) await Promise.resolve();
        });

        expect(mocks.downloadImageBatch).toHaveBeenCalledTimes(2);
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-summary' })
            .findAllByType('Text').map((node: any) => node.children.join('')))
            .toContain('Photos access is required to save generated images');
        expect(renderer.root.findAllByProps({ testID: 'attachment-gallery-download-retry' })).toHaveLength(1);
        act(() => renderer.unmount());
    });

    it.each([
        ['directory', 'No folder selected · Choose a folder to save the images'],
        ['photos', 'Photos access is required to save generated images'],
        ['browser', 'Downloads cancelled · Try again and allow multiple downloads'],
        ['unsupported', 'Batch download is not available on this platform'],
    ] as const)('returns to ready with %s-specific inline guidance when cancelled', async (destination, guidance) => {
        const items = readyItems(2);
        mocks.downloadImageBatch.mockResolvedValue(result({ cancelled: true, destination }));

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={items}
                    displayedCount={2}
                    settledCount={2}
                    pendingCount={0}
                />,
            );
        });

        const button = renderer.root.findByProps({ testID: 'attachment-gallery-download-all' });
        await act(async () => {
            await button.props.onPress();
        });

        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.disabled).toBe(false);
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-summary' })
            .findByType('Text').children.join('')).toBe(guidance);

        act(() => renderer.unmount());
    });

    it.each([
        ['browser', '2 downloads started · Allow multiple downloads if your browser asks'],
        ['directory', 'Saved 2 to the selected folder'],
        ['photos', 'Saved 2 to Photos'],
    ] as const)('preserves the %s destination in success guidance', async (destination, message) => {
        const items = readyItems(2);
        mocks.downloadImageBatch.mockResolvedValue(result({
            succeeded: items.map((item) => item.id),
            destination,
        }));

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <GeneratedImageBatchDownload items={items} displayedCount={2} settledCount={2} pendingCount={0} />,
            );
        });
        await act(async () => {
            await renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onPress();
        });

        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-success' })
            .children.join('')).toBe(message);
        act(() => renderer.unmount());
    });

    it('hides the batch action when generation settles with only one completed image', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={readyItems(1)}
                    displayedCount={1}
                    settledCount={1}
                    pendingCount={0}
                />,
            );
        });

        expect(renderer.root.findAllByProps({ testID: 'attachment-gallery-download-all' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('keeps an in-flight batch owned across unmount and remount', async () => {
        const items = readyItems(2);
        const pendingDownload = deferred<ImageBatchDownloadResult>();
        mocks.downloadImageBatch.mockReturnValue(pendingDownload.promise);

        let firstRenderer: any;
        act(() => {
            firstRenderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={items}
                    displayedCount={2}
                    settledCount={2}
                    pendingCount={0}
                />,
            );
        });

        act(() => {
            void firstRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onPress();
            firstRenderer.unmount();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(mocks.downloadImageBatch).toHaveBeenCalledTimes(1);
        act(() => {
            mocks.downloadImageBatch.mock.calls[0][1].onProgress({
                completed: 1,
                total: 2,
                succeeded: 1,
                failed: 0,
                currentId: 'image-1',
            });
        });

        let secondRenderer: any;
        act(() => {
            secondRenderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={items}
                    displayedCount={2}
                    settledCount={2}
                    pendingCount={0}
                />,
            );
        });

        const remountedButton = secondRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' });
        expect(remountedButton.props.disabled).toBe(true);
        expect(remountedButton.findByType('Text').children.join('')).toContain('1/2');
        act(() => {
            void remountedButton.props.onPress();
        });
        expect(mocks.downloadImageBatch).toHaveBeenCalledTimes(1);

        await act(async () => {
            pendingDownload.resolve(result({ succeeded: items.map((item) => item.id) }));
            await pendingDownload.promise;
            await Promise.resolve();
        });
        expect(secondRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.disabled).toBe(false);
        act(() => {
            mocks.downloadImageBatch.mock.calls[0][1].onProgress({
                completed: 2,
                total: 2,
                succeeded: 2,
                failed: 0,
                currentId: 'image-2',
            });
        });
        expect(secondRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' })
            .findByType('Text').children.join('')).toBe('Download all 2');

        act(() => secondRenderer.unmount());
    });

    it('keeps concurrent progress and results isolated by stable batch identity', async () => {
        const firstItems = readyItems(2, 'first');
        const secondItems = readyItems(2, 'second');
        const firstDownload = deferred<ImageBatchDownloadResult>();
        const secondDownload = deferred<ImageBatchDownloadResult>();
        mocks.downloadImageBatch
            .mockReturnValueOnce(firstDownload.promise)
            .mockReturnValueOnce(secondDownload.promise);

        let firstRenderer: any;
        let secondRenderer: any;
        act(() => {
            firstRenderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={firstItems}
                    displayedCount={2}
                    settledCount={2}
                    pendingCount={0}
                />,
            );
            secondRenderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={secondItems}
                    displayedCount={2}
                    settledCount={2}
                    pendingCount={0}
                />,
            );
        });

        act(() => {
            void firstRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });
        const secondDisabledWhileFirstRuns = secondRenderer.root
            .findByProps({ testID: 'attachment-gallery-download-all' }).props.disabled;
        act(() => {
            mocks.downloadImageBatch.mock.calls[0][1].onProgress({
                completed: 1,
                total: 2,
                succeeded: 1,
                failed: 0,
                currentId: 'first-1',
            });
            void secondRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });
        const callCountWhileBothRun = mocks.downloadImageBatch.mock.calls.length;
        const firstLabel = firstRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' })
            .findByType('Text').children.join('');
        const secondLabel = secondRenderer.root.findByProps({ testID: 'attachment-gallery-download-all' })
            .findByType('Text').children.join('');

        await act(async () => {
            firstDownload.resolve(result({ succeeded: firstItems.map((item) => item.id) }));
            secondDownload.resolve(result({ succeeded: secondItems.map((item) => item.id) }));
            await Promise.all([firstDownload.promise, secondDownload.promise]);
            await Promise.resolve();
        });
        const firstSummary = firstRenderer.root.findByProps({ testID: 'attachment-gallery-download-summary' })
            .findByType('Text').children.join('');
        const secondSummaryCount = secondRenderer.root
            .findAllByProps({ testID: 'attachment-gallery-download-summary' }).length;
        act(() => {
            firstRenderer.unmount();
            secondRenderer.unmount();
        });

        expect(secondDisabledWhileFirstRuns).toBe(false);
        expect(callCountWhileBothRun).toBe(2);
        expect(firstLabel).toContain('1/2');
        expect(secondLabel).not.toContain('1/2');
        expect(firstSummary).toBe('Saved 2 to Photos');
        expect(secondSummaryCount).toBe(1);
        expect(mocks.downloadImageBatch.mock.calls[1][0]).toEqual(
            secondItems.map((item, index) => ({ ...item, ordinal: index + 1 })),
        );
    });

    it('routes unexpected download rejection through the standard error action without leaking a promise', async () => {
        const items = readyItems(2);
        mocks.downloadImageBatch.mockRejectedValue(new Error('destination failed'));

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <GeneratedImageBatchDownload
                    items={items}
                    displayedCount={2}
                    settledCount={2}
                    pendingCount={0}
                />,
            );
        });

        let pressResult: unknown;
        act(() => {
            pressResult = renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.onPress();
            if (pressResult instanceof Promise) {
                void pressResult.catch(() => {});
            }
        });
        await act(async () => {
            for (let index = 0; index < 6; index += 1) await Promise.resolve();
        });

        expect(pressResult).toBeUndefined();
        expect(mocks.alert).toHaveBeenCalledWith(
            'Error',
            'Unknown error',
            [{ text: 'OK', style: 'cancel' }],
        );
        expect(renderer.root.findByProps({ testID: 'attachment-gallery-download-all' }).props.disabled).toBe(false);

        act(() => renderer.unmount());
    });
});
