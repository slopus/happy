import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTerminalScannerPayload } from './handleTerminalScannerPayload';

test('shows an invalid QR alert for unsupported payloads on iOS', async () => {
    let dismissScannerCallCount = 0;
    let processTerminalAuthUrlCallCount = 0;
    let showUnsupportedQrAlertCallCount = 0;

    const result = await handleTerminalScannerPayload('https://huppy.ai/demo-pairing', {
        platformOs: 'ios',
        dismissScanner: async () => {
            dismissScannerCallCount += 1;
        },
        processTerminalAuthUrl: async () => {
            processTerminalAuthUrlCallCount += 1;
        },
        showUnsupportedQrAlert: () => {
            showUnsupportedQrAlertCallCount += 1;
        },
    });

    assert.equal(result, 'unsupported');
    assert.equal(dismissScannerCallCount, 1);
    assert.equal(processTerminalAuthUrlCallCount, 0);
    assert.equal(showUnsupportedQrAlertCallCount, 1);
});

test('continues processing a valid terminal auth URL even if dismissing the scanner fails', async () => {
    const dismissError = new Error('dismiss failed');
    const processedUrls: string[] = [];
    const dismissErrors: Error[] = [];
    let showUnsupportedQrAlertCallCount = 0;

    const result = await handleTerminalScannerPayload(' huppy://terminal?abc123 ', {
        platformOs: 'ios',
        dismissScanner: async () => {
            throw dismissError;
        },
        processTerminalAuthUrl: async (url) => {
            processedUrls.push(url);
        },
        showUnsupportedQrAlert: () => {
            showUnsupportedQrAlertCallCount += 1;
        },
        onDismissScannerError: (error) => {
            dismissErrors.push(error as Error);
        },
    });

    assert.equal(result, 'terminal-auth');
    assert.deepEqual(processedUrls, ['huppy://terminal?abc123']);
    assert.equal(showUnsupportedQrAlertCallCount, 0);
    assert.deepEqual(dismissErrors, [dismissError]);
});
