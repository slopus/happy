import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    accountAuth: vi.fn(async () => true),
    accountLoading: false,
    alert: vi.fn(),
    checkPermissions: vi.fn(async () => true),
    confirm: vi.fn(async () => true),
    dismissScanner: vi.fn(async () => {}),
    launchScanner: vi.fn(async () => {}),
    listeners: [] as Array<(event: { data: string }) => Promise<void>>,
    onScanned: undefined as undefined | ((event: { data: string }) => Promise<void>),
    platformOS: 'ios',
    removeSubscription: vi.fn(),
    scannerAvailable: true,
    terminalAuth: vi.fn(async () => true),
    terminalLoading: false,
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return mocks.platformOS; } } }));
vi.mock('expo-camera', () => ({
    CameraView: {
        dismissScanner: mocks.dismissScanner,
        get isModernBarcodeScannerAvailable() { return mocks.scannerAvailable; },
        launchScanner: mocks.launchScanner,
        onModernBarcodeScanned: (listener: (event: { data: string }) => Promise<void>) => {
            mocks.listeners.push(listener);
            mocks.onScanned = listener;
            return { remove: mocks.removeSubscription };
        },
    },
}));
vi.mock('@/hooks/useCheckCameraPermissions', () => ({
    useCheckScannerPermissions: () => mocks.checkPermissions,
}));
vi.mock('@/hooks/useConnectAccount', () => ({
    useConnectAccount: () => ({ isLoading: mocks.accountLoading, processAuthUrl: mocks.accountAuth }),
}));
vi.mock('@/hooks/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ isLoading: mocks.terminalLoading, processAuthUrl: mocks.terminalAuth }),
}));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert, confirm: mocks.confirm } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { UnifiedAuthQrCodeProvider, useUnifiedAuthQrCode } from './useUnifiedAuthQrCode';

const accountAuthUrl = 'paws:///account?dh2I7IMEE5Gd_p1NHVbxfmU8jJlAgt9bE3uQoK5u33Q';
const terminalAuthUrl = 'paws://terminal?AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

function Probe({ onReady }: { onReady: (value: ReturnType<typeof useUnifiedAuthQrCode>) => void }) {
    onReady(useUnifiedAuthQrCode());
    return null;
}

describe('useUnifiedAuthQrCode', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
    let current: ReturnType<typeof useUnifiedAuthQrCode>;
    let renderer: TestRenderer.ReactTestRenderer;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mocks.accountAuth.mockClear();
        mocks.accountLoading = false;
        mocks.alert.mockClear();
        mocks.checkPermissions.mockReset();
        mocks.checkPermissions.mockResolvedValue(true);
        mocks.confirm.mockReset();
        mocks.confirm.mockResolvedValue(true);
        mocks.dismissScanner.mockClear();
        mocks.launchScanner.mockClear();
        mocks.listeners.length = 0;
        mocks.onScanned = undefined;
        mocks.platformOS = 'ios';
        mocks.removeSubscription.mockClear();
        mocks.scannerAvailable = true;
        mocks.terminalAuth.mockClear();
        mocks.terminalLoading = false;
        act(() => {
            renderer = TestRenderer.create(
                <UnifiedAuthQrCodeProvider>
                    <Probe onReady={(value) => { current = value; }} />
                </UnifiedAuthQrCodeProvider>,
            );
        });
    });

    afterEach(() => {
        act(() => renderer.unmount());
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
    });

    it('opens the native QR scanner after permission is granted', async () => {
        await act(async () => {
            await current.connectAuthQrCode();
        });

        expect(mocks.launchScanner).toHaveBeenCalledWith({ barcodeTypes: ['qr'] });
    });

    it('shows a recoverable error when scanner permission is unavailable', async () => {
        mocks.checkPermissions.mockResolvedValue(false);

        await act(async () => {
            await current.connectAuthQrCode();
        });

        expect(mocks.launchScanner).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith(
            'common.error',
            'modals.cameraPermissionsRequiredToScanQr',
            [{ text: 'common.ok' }],
        );
    });

    it('shows a recoverable error when the native scanner is unavailable', async () => {
        mocks.scannerAvailable = false;

        await act(async () => {
            await current.connectAuthQrCode();
        });

        expect(mocks.checkPermissions).not.toHaveBeenCalled();
        expect(mocks.launchScanner).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledTimes(1);
    });

    it('releases the scanner guard when checking permission rejects', async () => {
        mocks.checkPermissions
            .mockRejectedValueOnce(new Error('permission check failed'))
            .mockResolvedValueOnce(true);

        await act(async () => {
            await current.connectAuthQrCode();
            await current.connectAuthQrCode();
        });

        expect(mocks.alert).toHaveBeenCalledTimes(1);
        expect(mocks.launchScanner).toHaveBeenCalledTimes(1);
    });

    it('dismisses a possibly attached iOS scanner before retrying after launch rejection', async () => {
        mocks.launchScanner
            .mockRejectedValueOnce(new Error('launch failed'))
            .mockResolvedValueOnce(undefined);

        await act(async () => {
            await current.connectAuthQrCode();
            await current.connectAuthQrCode();
        });

        expect(mocks.alert).toHaveBeenCalledTimes(1);
        expect(mocks.dismissScanner).toHaveBeenCalledTimes(1);
        expect(mocks.launchScanner).toHaveBeenCalledTimes(2);
        expect(mocks.dismissScanner.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.launchScanner.mock.invocationCallOrder[1],
        );
    });

    it('waits for native iOS presentation completion before replacing a provider launch', async () => {
        let resolveOldLaunch!: () => void;
        mocks.launchScanner.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveOldLaunch = resolve;
        }));

        const oldLaunch = current.connectAuthQrCode();
        await act(async () => {
            await Promise.resolve();
        });
        act(() => renderer.unmount());
        act(() => {
            renderer = TestRenderer.create(
                <UnifiedAuthQrCodeProvider>
                    <Probe onReady={(value) => { current = value; }} />
                </UnifiedAuthQrCodeProvider>,
            );
        });

        const replacementLaunch = current.connectAuthQrCode();
        await act(async () => {
            await Promise.resolve();
        });
        expect(mocks.launchScanner).toHaveBeenCalledTimes(1);

        resolveOldLaunch();
        await act(async () => {
            await oldLaunch;
            await replacementLaunch;
        });

        expect(mocks.dismissScanner).toHaveBeenCalled();
        expect(mocks.launchScanner).toHaveBeenCalledTimes(2);
    });

    it('does not show an error when Android scanning is cancelled by the user', async () => {
        mocks.platformOS = 'android';
        mocks.launchScanner.mockRejectedValueOnce({ code: 'ERR_BARCODE_SCANNING_CANCELLED' });

        await act(async () => {
            await current.connectAuthQrCode();
        });

        expect(mocks.alert).not.toHaveBeenCalled();
    });

    it('dismisses a stale iOS scanner session before launching it again', async () => {
        await act(async () => {
            await current.connectAuthQrCode();
            await current.connectAuthQrCode();
        });

        expect(mocks.dismissScanner).toHaveBeenCalledTimes(1);
        expect(mocks.launchScanner).toHaveBeenCalledTimes(2);
    });

    it('does not relaunch a stale scanner when its dismissal outlives the provider', async () => {
        await act(async () => {
            await current.connectAuthQrCode();
        });

        let resolveDismissal!: () => void;
        mocks.dismissScanner.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveDismissal = resolve;
        }));
        const retry = current.connectAuthQrCode();
        await act(async () => {
            await Promise.resolve();
        });
        act(() => renderer.unmount());

        resolveDismissal();
        await act(async () => {
            await retry;
        });

        expect(mocks.launchScanner).toHaveBeenCalledTimes(1);
    });

    it('waits for native iOS dismissal completion before a replacement provider launches', async () => {
        await act(async () => {
            await current.connectAuthQrCode();
        });

        let resolveDismissal!: () => void;
        mocks.dismissScanner.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveDismissal = resolve;
        }));
        act(() => renderer.unmount());
        act(() => {
            renderer = TestRenderer.create(
                <UnifiedAuthQrCodeProvider>
                    <Probe onReady={(value) => { current = value; }} />
                </UnifiedAuthQrCodeProvider>,
            );
        });

        const replacementLaunch = current.connectAuthQrCode();
        await act(async () => {
            await Promise.resolve();
        });
        expect(mocks.launchScanner).toHaveBeenCalledTimes(1);

        resolveDismissal();
        await act(async () => {
            await replacementLaunch;
        });

        expect(mocks.launchScanner).toHaveBeenCalledTimes(2);
    });

    it('waits for a cleanup dismissal retry before a replacement provider launches', async () => {
        await act(async () => {
            await current.connectAuthQrCode();
        });

        let rejectFirstDismissal!: (error: Error) => void;
        let resolveRetryDismissal!: () => void;
        mocks.dismissScanner
            .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
                rejectFirstDismissal = reject;
            }))
            .mockImplementationOnce(() => new Promise<void>((resolve) => {
                resolveRetryDismissal = resolve;
            }));

        act(() => renderer.unmount());
        act(() => {
            renderer = TestRenderer.create(
                <UnifiedAuthQrCodeProvider>
                    <Probe onReady={(value) => { current = value; }} />
                </UnifiedAuthQrCodeProvider>,
            );
        });

        const replacementLaunch = current.connectAuthQrCode();
        await act(async () => {
            await Promise.resolve();
        });

        rejectFirstDismissal(new Error('cleanup failed once'));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.dismissScanner).toHaveBeenCalledTimes(2);
        expect(mocks.launchScanner).toHaveBeenCalledTimes(1);

        resolveRetryDismissal();
        await act(async () => {
            await replacementLaunch;
        });

        expect(mocks.launchScanner).toHaveBeenCalledTimes(2);
    });

    it.each([
        [accountAuthUrl, 'account'],
        [terminalAuthUrl, 'terminal'],
    ] as const)('routes a %s URL only to the %s authenticator', async (url, expectedAuthenticator) => {
        await act(async () => {
            await current.connectWithUrl(url);
        });

        expect(mocks.accountAuth).toHaveBeenCalledTimes(expectedAuthenticator === 'account' ? 1 : 0);
        expect(mocks.terminalAuth).toHaveBeenCalledTimes(expectedAuthenticator === 'terminal' ? 1 : 0);
    });

    it.each([
        [accountAuthUrl, 'navigation.linkNewDevice', 'settingsAccount.linkNewDeviceSubtitle'],
        [terminalAuthUrl, 'navigation.connectTerminal', 'terminal.terminalRequestDescription'],
    ] as const)('confirms the detected authorization type before processing %s', async (url, title, message) => {
        await act(async () => {
            await current.connectWithUrl(url);
        });

        expect(mocks.confirm).toHaveBeenCalledWith(title, message, {
            cancelText: 'common.cancel',
            confirmText: 'common.continue',
        });
    });

    it('does not authenticate when the detected authorization type is declined', async () => {
        mocks.confirm.mockResolvedValueOnce(false);

        await act(async () => {
            await current.connectWithUrl(accountAuthUrl);
        });

        expect(mocks.accountAuth).not.toHaveBeenCalled();
        expect(mocks.terminalAuth).not.toHaveBeenCalled();
    });

    it('does not authenticate when confirmation resolves after the provider unmounts', async () => {
        let resolveConfirmation!: (value: boolean) => void;
        mocks.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            resolveConfirmation = resolve;
        }));

        const attempt = current.connectWithUrl(accountAuthUrl);
        await act(async () => {
            await Promise.resolve();
        });
        act(() => renderer.unmount());

        resolveConfirmation(true);
        await act(async () => {
            await attempt;
        });

        expect(mocks.accountAuth).not.toHaveBeenCalled();
    });

    it('explains unsupported authentication URLs without calling either authenticator', async () => {
        await act(async () => {
            await current.connectWithUrl('https://example.com/not-a-paws-code');
        });

        expect(mocks.accountAuth).not.toHaveBeenCalled();
        expect(mocks.terminalAuth).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'modals.invalidAuthUrl', [
            { text: 'common.ok' },
        ]);
    });

    it('routes scanned account and terminal URLs through the matching authenticator', async () => {
        expect(mocks.onScanned).toBeDefined();

        await act(async () => {
            await current.connectAuthQrCode();
            await mocks.onScanned?.({ data: accountAuthUrl });
        });
        await act(async () => {
            await current.connectAuthQrCode();
            await mocks.onScanned?.({ data: terminalAuthUrl });
        });

        expect(mocks.accountAuth).toHaveBeenCalledWith(accountAuthUrl);
        expect(mocks.terminalAuth).toHaveBeenCalledWith(terminalAuthUrl);
        expect(mocks.dismissScanner).toHaveBeenCalledTimes(2);
    });

    it('processes an Android scan event before the native launch promise settles', async () => {
        mocks.platformOS = 'android';
        let resolveLaunch!: () => void;
        mocks.launchScanner.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveLaunch = resolve;
        }));

        const launch = current.connectAuthQrCode();
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await mocks.onScanned?.({ data: terminalAuthUrl });
        });

        expect(mocks.terminalAuth).toHaveBeenCalledWith(terminalAuthUrl);

        resolveLaunch();
        await act(async () => {
            await launch;
        });
    });

    it('ignores scanner events when this provider did not launch the scanner', async () => {
        await act(async () => {
            await mocks.onScanned?.({ data: accountAuthUrl });
        });

        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.accountAuth).not.toHaveBeenCalled();
        expect(mocks.dismissScanner).not.toHaveBeenCalled();
    });

    it('does not open confirmation when scanner dismissal resolves after unmount', async () => {
        await act(async () => {
            await current.connectAuthQrCode();
        });

        let resolveDismissal!: () => void;
        mocks.dismissScanner.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveDismissal = resolve;
        }));
        const scan = mocks.onScanned!({ data: accountAuthUrl });
        await act(async () => {
            await Promise.resolve();
        });
        act(() => renderer.unmount());

        resolveDismissal();
        await act(async () => {
            await scan;
        });

        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.accountAuth).not.toHaveBeenCalled();
    });

    it('ignores a duplicate scan while authentication is still in progress', async () => {
        let resolveAuthentication!: (value: boolean) => void;
        mocks.accountAuth.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            resolveAuthentication = resolve;
        }));

        let firstScan!: Promise<void>;
        let duplicateScan!: Promise<void>;
        await act(async () => {
            await current.connectAuthQrCode();
            firstScan = mocks.onScanned!({ data: accountAuthUrl });
            duplicateScan = mocks.onScanned!({ data: accountAuthUrl });
            await Promise.resolve();
        });

        expect(mocks.accountAuth).toHaveBeenCalledTimes(1);

        resolveAuthentication(true);
        await act(async () => {
            await Promise.all([firstScan, duplicateScan]);
        });
    });

    it('ignores a duplicate pasted URL while authentication is still in progress', async () => {
        let resolveAuthentication!: (value: boolean) => void;
        mocks.accountAuth.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            resolveAuthentication = resolve;
        }));

        let firstAttempt!: Promise<boolean>;
        let duplicateAttempt!: Promise<boolean>;
        await act(async () => {
            firstAttempt = current.connectWithUrl(accountAuthUrl);
            duplicateAttempt = current.connectWithUrl(accountAuthUrl);
            await Promise.resolve();
        });

        expect(mocks.accountAuth).toHaveBeenCalledTimes(1);

        resolveAuthentication(true);
        await act(async () => {
            await Promise.all([firstAttempt, duplicateAttempt]);
        });
    });

    it('dismisses an owned iOS scanner even when another authentication owns the single-flight guard', async () => {
        let resolveAuthentication!: (value: boolean) => void;
        mocks.accountAuth.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            resolveAuthentication = resolve;
        }));

        const firstAttempt = current.connectWithUrl(accountAuthUrl);
        await act(async () => {
            await Promise.resolve();
            await current.connectAuthQrCode();
            await mocks.onScanned?.({ data: terminalAuthUrl });
        });

        expect(mocks.dismissScanner).toHaveBeenCalledTimes(1);
        expect(mocks.terminalAuth).not.toHaveBeenCalled();

        resolveAuthentication(true);
        await act(async () => {
            await firstAttempt;
        });
    });

    it('keeps authentication single-flight ownership across provider replacement', async () => {
        let resolveAuthentication!: (value: boolean) => void;
        mocks.accountAuth.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            resolveAuthentication = resolve;
        }));

        const firstAttempt = current.connectWithUrl(accountAuthUrl);
        await act(async () => {
            await Promise.resolve();
        });
        act(() => renderer.unmount());
        act(() => {
            renderer = TestRenderer.create(
                <UnifiedAuthQrCodeProvider>
                    <Probe onReady={(value) => { current = value; }} />
                </UnifiedAuthQrCodeProvider>,
            );
        });

        await act(async () => {
            await current.connectWithUrl(terminalAuthUrl);
        });

        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        expect(mocks.terminalAuth).not.toHaveBeenCalled();

        resolveAuthentication(true);
        await act(async () => {
            await firstAttempt;
        });
    });

    it('releases the authentication guard after an authenticator rejects', async () => {
        mocks.accountAuth
            .mockRejectedValueOnce(new Error('authentication failed'))
            .mockResolvedValueOnce(true);

        await expect(current.connectWithUrl(accountAuthUrl)).rejects.toThrow('authentication failed');

        await act(async () => {
            await current.connectWithUrl(accountAuthUrl);
        });

        expect(mocks.accountAuth).toHaveBeenCalledTimes(2);
    });

    it('continues authentication when dismissing the iOS scanner fails', async () => {
        mocks.dismissScanner.mockRejectedValueOnce(new Error('dismiss failed'));

        await act(async () => {
            await current.connectAuthQrCode();
            await mocks.onScanned?.({ data: accountAuthUrl });
        });

        expect(mocks.accountAuth).toHaveBeenCalledWith(accountAuthUrl);
        expect(mocks.dismissScanner).toHaveBeenCalledTimes(2);
    });

    it('does not authenticate while the iOS scanner cannot be dismissed', async () => {
        mocks.dismissScanner
            .mockRejectedValueOnce(new Error('dismiss failed once'))
            .mockRejectedValueOnce(new Error('dismiss failed twice'));

        await act(async () => {
            await current.connectAuthQrCode();
            await mocks.onScanned?.({ data: accountAuthUrl });
        });

        expect(mocks.dismissScanner).toHaveBeenCalledTimes(2);
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.accountAuth).not.toHaveBeenCalled();
    });

    it('removes its listener and dismisses the iOS scanner when the screen unmounts', async () => {
        await act(async () => {
            await current.connectAuthQrCode();
        });

        await act(async () => {
            renderer.unmount();
            await Promise.resolve();
        });

        expect(mocks.removeSubscription).toHaveBeenCalledTimes(1);
        expect(mocks.dismissScanner).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss a scanner it did not launch when the provider unmounts', async () => {
        await act(async () => {
            renderer.unmount();
            await Promise.resolve();
        });

        expect(mocks.removeSubscription).toHaveBeenCalledTimes(1);
        expect(mocks.dismissScanner).not.toHaveBeenCalled();
    });

    it('retries cleanup dismissal and carries stale ownership into a replacement provider', async () => {
        await act(async () => {
            await current.connectAuthQrCode();
        });
        mocks.dismissScanner
            .mockRejectedValueOnce(new Error('cleanup failed once'))
            .mockRejectedValueOnce(new Error('cleanup failed twice'))
            .mockResolvedValueOnce(undefined);

        await act(async () => {
            renderer.unmount();
            await Promise.resolve();
            await Promise.resolve();
        });

        act(() => {
            renderer = TestRenderer.create(
                <UnifiedAuthQrCodeProvider>
                    <Probe onReady={(value) => { current = value; }} />
                </UnifiedAuthQrCodeProvider>,
            );
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.dismissScanner).toHaveBeenCalledTimes(3);
    });

    it('does not launch the scanner after a pending permission check outlives the provider', async () => {
        let resolvePermission!: (value: boolean) => void;
        mocks.checkPermissions.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            resolvePermission = resolve;
        }));

        let attempt!: Promise<void>;
        await act(async () => {
            attempt = current.connectAuthQrCode();
            await Promise.resolve();
        });

        act(() => renderer.unmount());
        resolvePermission(true);
        await act(async () => {
            await attempt;
        });

        expect(mocks.launchScanner).not.toHaveBeenCalled();
    });

    it('reports loading while either authenticator is busy', () => {
        act(() => renderer.unmount());
        mocks.terminalLoading = true;

        act(() => {
            renderer = TestRenderer.create(
                <UnifiedAuthQrCodeProvider>
                    <Probe onReady={(value) => { current = value; }} />
                </UnifiedAuthQrCodeProvider>,
            );
        });

        expect(current.isLoading).toBe(true);
    });

    it('registers one native listener when two consumers are mounted together', () => {
        act(() => renderer.unmount());
        mocks.listeners.length = 0;

        act(() => {
            renderer = TestRenderer.create(
                <UnifiedAuthQrCodeProvider>
                    <Probe onReady={(value) => { current = value; }} />
                    <Probe onReady={(value) => { current = value; }} />
                </UnifiedAuthQrCodeProvider>,
            );
        });

        expect(mocks.listeners).toHaveLength(1);
    });
});
