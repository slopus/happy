import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

type MockPickedImage = {
    id: string;
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    size: number;
    name: string;
    thumbhash?: string;
};

const mocks = vi.hoisted(() => ({
    candidate: {
        provider: 'pexels' as const,
        photoId: 731889,
        previewUrl: 'https://images.pexels.com/photos/731889/pexels-photo-731889.jpeg',
        width: 1800,
        height: 1200,
        averageColor: '#786f64',
        attribution: {
            photographer: 'Ada Stone',
            photographerUrl: 'https://www.pexels.com/@ada-stone',
            photoUrl: 'https://www.pexels.com/photo/731889',
        },
    },
    getRandomCover: vi.fn(),
    setLastThemePack: vi.fn(),
    mutableSettingNames: [] as string[],
    pickImages: vi.fn<() => Promise<MockPickedImage[]>>(async () => []),
    clearImages: vi.fn(),
    selectedImages: [] as MockPickedImage[],
    pickerOptions: [] as Array<{ maxAttachments?: number; maxImageSizeBytes?: number }>,
    openUrl: vi.fn(),
    uuid: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Linking: { openURL: mocks.openUrl },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-crypto', () => ({ randomUUID: mocks.uuid }));
vi.mock('@/sync/storage', () => ({
    useLocalSettingMutable: (name: string) => {
        mocks.mutableSettingNames.push(name);
        return ['caramel', mocks.setLastThemePack];
    },
}));
vi.mock('@/sync/sync', () => ({ sync: { getCredentials: () => ({ token: 'token', secret: 'secret' }) } }));
vi.mock('@/sync/apiPublicSessionShares', () => ({ getRandomPublicSessionCover: mocks.getRandomCover }));
vi.mock('@/hooks/useImagePicker', () => ({
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    useImagePicker: (options: { maxAttachments?: number; maxImageSizeBytes?: number }) => {
        mocks.pickerOptions.push(options);
        return {
            selectedImages: mocks.selectedImages,
            pickImages: mocks.pickImages,
            clearImages: mocks.clearImages,
        };
    },
}));
vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (key === 'sessionShare.coverAttribution') {
            return `Photo by ${params?.photographer} on Pexels`;
        }
        if (key === 'sessionShare.themeColorOption') {
            return `Theme color: ${params?.theme}`;
        }
        return key;
    },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory({
            colors: {
                accent: '#08f',
                divider: '#444',
                surface: '#181818',
                surfaceHigh: '#222',
                surfacePressed: '#2a2a2a',
                surfaceSelected: '#333',
                text: '#fff',
                textSecondary: '#aaa',
                status: { error: '#f44' },
            },
        }),
    },
}));

import { PublicSessionShareAppearanceControls } from './PublicSessionShareAppearanceControls';

type Props = React.ComponentProps<typeof PublicSessionShareAppearanceControls>;

function renderControls(overrides: Partial<Props> = {}) {
    const props: Props = {
        sessionId: 'session-1',
        themePack: 'caramel',
        coverSelection: undefined,
        onThemePackChange: vi.fn(),
        onCoverSelectionChange: vi.fn(),
        onReplacementBusyChange: vi.fn(),
        ...overrides,
    };
    let renderer: any;
    act(() => {
        renderer = TestRenderer.create(<PublicSessionShareAppearanceControls {...props} />);
    });
    return { props, renderer };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, reject, resolve };
}

describe('PublicSessionShareAppearanceControls', () => {
    const pickedImage = {
        id: 'picker-preview-id',
        uri: 'file:///tmp/cover.webp',
        width: 1600,
        height: 900,
        mimeType: 'image/webp',
        size: 2048,
        name: 'cover.webp',
        thumbhash: 'thumb',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mutableSettingNames.length = 0;
        mocks.pickerOptions.length = 0;
        mocks.selectedImages = [];
        mocks.pickImages.mockResolvedValue([]);
        mocks.getRandomCover.mockResolvedValue(mocks.candidate);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('renders all seven real accent IDs as accessible theme choices', () => {
        const { renderer } = renderControls();

        const swatches = renderer.root.findAll((node: any) => (
            node.props.accessibilityRole === 'radio' && typeof node.props.testID === 'string'
        ));
        expect(swatches.map((node: any) => node.props.testID)).toEqual([
            'public-share-theme-caramel',
            'public-share-theme-gingham',
            'public-share-theme-terminal',
            'public-share-theme-acorn',
            'public-share-theme-sage',
            'public-share-theme-sakura',
            'public-share-theme-grape',
        ]);
        expect(renderer.root.findByProps({ testID: 'public-share-theme-caramel' }).props.accessibilityState)
            .toEqual({ checked: true, disabled: false });
        expect(swatches.map((node: any) => node.props['aria-checked'])).toEqual([
            true,
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
        expect(mocks.pickerOptions[0]).toEqual({
            maxAttachments: 1,
            maxImageSizeBytes: 50 * 1024 * 1024,
        });

        act(() => renderer.unmount());
    });

    it('remembers a share selection without changing the authenticated app theme', () => {
        const onThemePackChange = vi.fn();
        const { renderer } = renderControls({ onThemePackChange });

        act(() => renderer.root.findByProps({ testID: 'public-share-theme-sage' }).props.onPress());

        expect(mocks.mutableSettingNames).toEqual(['lastPublicShareThemePack']);
        expect(mocks.setLastThemePack).toHaveBeenCalledWith('sage');
        expect(onThemePackChange).toHaveBeenCalledWith('sage');
        act(() => renderer.unmount());
    });

    it('shows a random Pexels candidate and sends only its photo ID to publication state', async () => {
        const onCoverSelectionChange = vi.fn();
        const { renderer } = renderControls({ onCoverSelectionChange });

        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-share-cover-random' }).props.onPress();
        });

        const preview = renderer.root.findByProps({ testID: 'public-share-cover-preview' });
        expect(preview.props.source).toEqual({ uri: mocks.candidate.previewUrl });
        expect(preview.props.resizeMode).toBe('cover');
        expect(renderer.root.findByProps({ testID: 'public-share-cover-attribution' }).props.children)
            .toBe('Photo by Ada Stone on Pexels');
        expect(onCoverSelectionChange).toHaveBeenCalledWith({ kind: 'pexels', photoId: 731889 });
        expect(onCoverSelectionChange).not.toHaveBeenCalledWith(expect.objectContaining({
            previewUrl: expect.anything(),
        }));
        act(() => renderer.unmount());
    });

    it('reports a pending random replacement until it resolves', async () => {
        const pending = deferred<typeof mocks.candidate>();
        mocks.getRandomCover.mockReturnValueOnce(pending.promise);
        const onReplacementBusyChange = vi.fn();
        const { renderer } = renderControls({ onReplacementBusyChange });

        let randomPromise!: Promise<void>;
        act(() => {
            randomPromise = renderer.root.findByProps({ testID: 'public-share-cover-random' }).props.onPress();
        });

        expect(onReplacementBusyChange).toHaveBeenLastCalledWith(true);
        expect(renderer.root.findByProps({ testID: 'public-share-appearance-controls' }).props.accessibilityState)
            .toEqual({ busy: true });
        expect(renderer.root.findByProps({ testID: 'public-share-cover-replacement-state' }).props)
            .toMatchObject({ accessibilityLiveRegion: 'polite', children: 'sessionShare.preparing' });

        await act(async () => {
            pending.resolve(mocks.candidate);
            await randomPromise;
        });

        expect(onReplacementBusyChange).toHaveBeenLastCalledWith(false);
        expect(renderer.root.findAllByProps({ testID: 'public-share-cover-replacement-state' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('reports a pending upload normalization until rejection settles', async () => {
        const pending = deferred<MockPickedImage[]>();
        mocks.pickImages.mockReturnValueOnce(pending.promise);
        const onReplacementBusyChange = vi.fn();
        const { renderer } = renderControls({ onReplacementBusyChange });

        let uploadPromise!: Promise<void>;
        act(() => {
            uploadPromise = renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });
        expect(onReplacementBusyChange).toHaveBeenLastCalledWith(true);

        await act(async () => {
            pending.reject(new Error('normalization failed'));
            await uploadPromise;
        });

        expect(onReplacementBusyChange).toHaveBeenLastCalledWith(false);
        expect(renderer.root.findByProps({ testID: 'public-share-cover-upload-state' })).toBeTruthy();
        act(() => renderer.unmount());
    });

    it('invalidates an unresolved replacement when publication disables the controls', async () => {
        const pending = deferred<typeof mocks.candidate>();
        mocks.getRandomCover.mockReturnValueOnce(pending.promise);
        const onCoverSelectionChange = vi.fn();
        const onReplacementBusyChange = vi.fn();
        const { renderer, props } = renderControls({ onCoverSelectionChange, onReplacementBusyChange });

        let randomPromise!: Promise<void>;
        act(() => {
            randomPromise = renderer.root.findByProps({ testID: 'public-share-cover-random' }).props.onPress();
        });
        act(() => renderer.update(
            <PublicSessionShareAppearanceControls {...props} disabled />,
        ));
        expect(onReplacementBusyChange).toHaveBeenLastCalledWith(false);

        await act(async () => {
            pending.resolve(mocks.candidate);
            await randomPromise;
        });

        expect(onCoverSelectionChange).not.toHaveBeenCalled();
        expect(renderer.root.findAllByProps({ testID: 'public-share-cover-preview' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('keeps upload and coverless actions available when Pexels is unavailable', async () => {
        mocks.getRandomCover.mockRejectedValueOnce(new Error('503 provider unavailable'));
        const { renderer } = renderControls();

        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-share-cover-random' }).props.onPress();
        });

        expect(renderer.root.findByProps({ testID: 'public-share-cover-provider-state' }).props.accessibilityRole)
            .toBe('alert');
        expect(renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.disabled).toBe(false);
        expect(renderer.root.findByProps({ testID: 'public-share-cover-remove' })).toBeTruthy();
        expect(renderer.root.findByProps({ testID: 'public-share-cover-empty' })).toBeTruthy();
        act(() => renderer.unmount());
    });

    it('removes the current candidate and ignores a stale random response', async () => {
        const pending = deferred<typeof mocks.candidate>();
        mocks.getRandomCover.mockReturnValueOnce(pending.promise);
        const onCoverSelectionChange = vi.fn();
        const { renderer } = renderControls({ onCoverSelectionChange });

        let randomPromise!: Promise<void>;
        act(() => {
            randomPromise = renderer.root.findByProps({ testID: 'public-share-cover-random' }).props.onPress();
        });
        act(() => renderer.root.findByProps({ testID: 'public-share-cover-remove' }).props.onPress());
        await act(async () => {
            pending.resolve(mocks.candidate);
            await randomPromise;
        });

        expect(onCoverSelectionChange).toHaveBeenLastCalledWith(undefined);
        expect(renderer.root.findAllByProps({ testID: 'public-share-cover-preview' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('turns one normalized picker image into a local-only upload selection', async () => {
        const onCoverSelectionChange = vi.fn();
        mocks.pickImages.mockResolvedValueOnce([pickedImage]);
        const { renderer } = renderControls({ onCoverSelectionChange });

        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });

        expect(onCoverSelectionChange).toHaveBeenCalledWith({
            kind: 'upload',
            attachmentId: '11111111-1111-4111-8111-111111111111',
            uri: 'file:///tmp/cover.webp',
            width: 1600,
            height: 900,
            mimeType: 'image/webp' as const,
            size: 2048,
            name: 'cover.webp',
            thumbhash: 'thumb',
        });
        act(() => renderer.unmount());
    });

    it('keeps remove as the last action when an older upload finishes late', async () => {
        const pending = deferred<typeof mocks.selectedImages>();
        mocks.pickImages.mockReturnValueOnce(pending.promise);
        const onCoverSelectionChange = vi.fn();
        const { renderer } = renderControls({ onCoverSelectionChange });

        let uploadPromise!: Promise<void>;
        act(() => {
            uploadPromise = renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });
        act(() => renderer.root.findByProps({ testID: 'public-share-cover-remove' }).props.onPress());
        mocks.selectedImages = [pickedImage];
        await act(async () => {
            pending.resolve([pickedImage]);
            renderer.update(
                <PublicSessionShareAppearanceControls
                    sessionId="session-1"
                    themePack="caramel"
                    coverSelection={undefined}
                    onThemePackChange={vi.fn()}
                    onCoverSelectionChange={onCoverSelectionChange}
                    onReplacementBusyChange={vi.fn()}
                />,
            );
            await uploadPromise;
        });

        expect(onCoverSelectionChange).toHaveBeenLastCalledWith(undefined);
        act(() => renderer.unmount());
    });

    it('keeps random as the last action when an older upload finishes late', async () => {
        const pending = deferred<typeof mocks.selectedImages>();
        mocks.pickImages.mockReturnValueOnce(pending.promise);
        const onCoverSelectionChange = vi.fn();
        const { renderer } = renderControls({ onCoverSelectionChange });

        let uploadPromise!: Promise<void>;
        act(() => {
            uploadPromise = renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });
        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-share-cover-random' }).props.onPress();
        });
        mocks.selectedImages = [pickedImage];
        await act(async () => {
            pending.resolve([pickedImage]);
            renderer.update(
                <PublicSessionShareAppearanceControls
                    sessionId="session-1"
                    themePack="caramel"
                    coverSelection={{ kind: 'pexels', photoId: 731889 }}
                    onThemePackChange={vi.fn()}
                    onCoverSelectionChange={onCoverSelectionChange}
                    onReplacementBusyChange={vi.fn()}
                />,
            );
            await uploadPromise;
        });

        expect(onCoverSelectionChange).toHaveBeenLastCalledWith({ kind: 'pexels', photoId: 731889 });
        act(() => renderer.unmount());
    });

    it('keeps a newer upload when an older picker finishes late', async () => {
        const pending = deferred<typeof mocks.selectedImages>();
        const newerImage = {
            ...pickedImage,
            id: 'newer-picker-id',
            uri: 'file:///tmp/newer-cover.webp',
            name: 'newer-cover.webp',
        };
        mocks.pickImages
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce([newerImage]);
        const onCoverSelectionChange = vi.fn();
        const { renderer } = renderControls({ onCoverSelectionChange });

        let olderPromise!: Promise<void>;
        act(() => {
            olderPromise = renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });
        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });
        pending.resolve([pickedImage]);
        await olderPromise;

        expect(onCoverSelectionChange).toHaveBeenCalledOnce();
        expect(onCoverSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
            kind: 'upload',
            uri: newerImage.uri,
            name: newerImage.name,
        }));
        act(() => renderer.unmount());
    });

    it('reports a picker rejection without replacing the current cover', async () => {
        mocks.pickImages.mockRejectedValueOnce(new Error('picker failed'));
        const onCoverSelectionChange = vi.fn();
        const { renderer } = renderControls({
            coverSelection: { kind: 'existing', assetId: '51515151-5151-4515-8515-515151515151' },
            existingCover: {
                assetId: '51515151-5151-4515-8515-515151515151',
                mimeType: 'image/webp',
                size: 5,
                width: 1200,
                height: 600,
                uri: 'https://paws.test/cover',
            },
            onCoverSelectionChange,
        });

        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });

        expect(renderer.root.findByProps({ testID: 'public-share-cover-upload-state' }).props.accessibilityRole)
            .toBe('alert');
        expect(onCoverSelectionChange).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({ testID: 'public-share-cover-preview' }).props.source)
            .toEqual({ uri: 'https://paws.test/cover' });
        act(() => renderer.unmount());
    });

    it('reports an unsupported picker image without replacing the current cover', async () => {
        mocks.pickImages.mockResolvedValueOnce([{
            ...pickedImage,
            uri: 'file:///tmp/animated.gif',
            name: 'animated.gif',
            mimeType: 'image/gif',
        }]);
        const onCoverSelectionChange = vi.fn();
        const { renderer } = renderControls({
            coverSelection: { kind: 'existing', assetId: '51515151-5151-4515-8515-515151515151' },
            existingCover: {
                assetId: '51515151-5151-4515-8515-515151515151',
                mimeType: 'image/webp',
                size: 5,
                width: 1200,
                height: 600,
                uri: 'https://paws.test/cover',
            },
            onCoverSelectionChange,
        });

        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });

        expect(renderer.root.findByProps({ testID: 'public-share-cover-upload-state' }).props.children)
            .toBe('sessionShare.coverUploadFailed');
        expect(onCoverSelectionChange).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({ testID: 'public-share-cover-preview' }).props.source)
            .toEqual({ uri: 'https://paws.test/cover' });
        act(() => renderer.unmount());
    });

    it('clears parent replacement busy state and ignores a deferred upload result after unmount', async () => {
        const pending = deferred<typeof mocks.selectedImages>();
        mocks.pickImages.mockReturnValueOnce(pending.promise);
        const onCoverSelectionChange = vi.fn();
        const onReplacementBusyChange = vi.fn();
        const { renderer } = renderControls({ onCoverSelectionChange, onReplacementBusyChange });

        let uploadPromise!: Promise<void>;
        act(() => {
            uploadPromise = renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
            renderer.unmount();
        });
        expect(onReplacementBusyChange.mock.calls).toEqual([[true], [false]]);
        pending.resolve([pickedImage]);
        await uploadPromise;

        expect(onCoverSelectionChange).not.toHaveBeenCalled();
    });

    it('clears parent replacement busy state and ignores a deferred random result after unmount', async () => {
        const pending = deferred<typeof mocks.candidate>();
        mocks.getRandomCover.mockReturnValueOnce(pending.promise);
        const onCoverSelectionChange = vi.fn();
        const onReplacementBusyChange = vi.fn();
        const { renderer } = renderControls({ onCoverSelectionChange, onReplacementBusyChange });

        let randomPromise!: Promise<void>;
        act(() => {
            randomPromise = renderer.root.findByProps({ testID: 'public-share-cover-random' }).props.onPress();
            renderer.unmount();
        });
        expect(onReplacementBusyChange.mock.calls).toEqual([[true], [false]]);
        pending.resolve(mocks.candidate);
        await randomPromise;

        expect(onCoverSelectionChange).not.toHaveBeenCalled();
    });

    it('keeps the current cover selection when a replacement upload is cancelled', async () => {
        const onCoverSelectionChange = vi.fn();
        const currentCover = {
            kind: 'upload' as const,
            attachmentId: '22222222-2222-4222-8222-222222222222',
            uri: 'file:///tmp/current.webp',
            width: 1600,
            height: 900,
            mimeType: 'image/webp' as const,
            size: 2048,
            name: 'current.webp',
        };
        const { renderer } = renderControls({ coverSelection: currentCover, onCoverSelectionChange });

        await act(async () => {
            await renderer.root.findByProps({ testID: 'public-share-cover-upload' }).props.onPress();
        });

        expect(mocks.clearImages).toHaveBeenCalledOnce();
        expect(mocks.pickImages).toHaveBeenCalledOnce();
        expect(onCoverSelectionChange).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({ testID: 'public-share-cover-preview' }).props.source)
            .toEqual({ uri: 'file:///tmp/current.webp' });
        act(() => renderer.unmount());
    });
});
