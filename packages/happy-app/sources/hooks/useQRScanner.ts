import * as React from 'react';
import { router } from 'expo-router';
import { useScannerEvents } from './useScannerEvents';

/**
 * Hook for launching the QR scanner and receiving scan results.
 * Uses react-native-vision-camera instead of expo-camera,
 * so it works on devices without Google Play Services.
 */
export function useQRScanner(onScanned: (code: string) => void) {
    const scanIdRef = React.useRef<string | null>(null);
    const onScannedRef = React.useRef(onScanned);
    onScannedRef.current = onScanned;

    const { lastScannedCode, scanId, clearScan } = useScannerEvents();

    // 监听扫描结果
    React.useEffect(() => {
        if (lastScannedCode && scanId && scanId === scanIdRef.current) {
            onScannedRef.current(lastScannedCode);
            clearScan();
            scanIdRef.current = null;
        }
    }, [lastScannedCode, scanId, clearScan]);

    const launchScanner = React.useCallback(() => {
        const newScanId = Math.random().toString(36).substring(2, 15);
        scanIdRef.current = newScanId;
        router.push({
            pathname: '/(app)/scanner',
            params: { scanId: newScanId },
        });
    }, []);

    return { launchScanner };
}
