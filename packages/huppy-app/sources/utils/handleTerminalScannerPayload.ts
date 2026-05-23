import { isTerminalAuthUrl } from './terminalAuthUrl';

export type TerminalScannerPayloadHandlingResult = 'terminal-auth' | 'unsupported';

interface HandleTerminalScannerPayloadOptions {
    platformOs: string;
    dismissScanner: () => Promise<void>;
    processTerminalAuthUrl: (url: string) => Promise<unknown>;
    showUnsupportedQrAlert: () => void;
    onDismissScannerError?: (error: unknown) => void;
}

export async function handleTerminalScannerPayload(
    rawPayload: string,
    {
        platformOs,
        dismissScanner,
        processTerminalAuthUrl,
        showUnsupportedQrAlert,
        onDismissScannerError,
    }: HandleTerminalScannerPayloadOptions,
): Promise<TerminalScannerPayloadHandlingResult> {
    const payload = rawPayload.trim();

    // iOS keeps the system scanner open until we dismiss it ourselves.
    if (platformOs === 'ios') {
        try {
            await dismissScanner();
        } catch (error) {
            onDismissScannerError?.(error);
        }
    }

    if (isTerminalAuthUrl(payload)) {
        await processTerminalAuthUrl(payload);
        return 'terminal-auth';
    }

    showUnsupportedQrAlert();
    return 'unsupported';
}
