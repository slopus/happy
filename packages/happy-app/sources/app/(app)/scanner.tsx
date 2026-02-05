import * as React from 'react';
import { memo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from 'react-native-vision-camera';
import { useLocalSearchParams, router } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useScannerEvents } from '@/hooks/useScannerEvents';
import { t } from '@/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function ScannerScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { scanId } = useLocalSearchParams<{ scanId: string }>();
    const device = useCameraDevice('back');
    const { hasPermission, requestPermission } = useCameraPermission();
    const emitScan = useScannerEvents((s) => s.emitScan);
    const hasScannedRef = React.useRef(false);

    // 请求权限
    React.useEffect(() => {
        if (!hasPermission) {
            requestPermission();
        }
    }, [hasPermission, requestPermission]);

    const handleCodeScanned = React.useCallback((value: string) => {
        if (value && !hasScannedRef.current && scanId) {
            hasScannedRef.current = true;
            emitScan(value, scanId);
            router.back();
        }
    }, [scanId, emitScan]);

    const codeScanner = useCodeScanner({
        codeTypes: ['qr'],
        onCodeScanned: (codes) => {
            const value = codes[0]?.value;
            if (value) {
                handleCodeScanned(value);
            }
        },
    });

    const handleClose = React.useCallback(() => {
        router.back();
    }, []);

    // 无权限状态
    if (!hasPermission) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
                <Text style={[styles.message, { color: theme.colors.text }]}>
                    {t('modals.cameraPermissionsRequiredToScanQr')}
                </Text>
                <TouchableOpacity style={styles.button} onPress={requestPermission}>
                    <Text style={styles.buttonText}>{t('common.grantPermission')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    // 无摄像头设备
    if (!device) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
                <Text style={[styles.message, { color: theme.colors.text }]}>
                    {t('errors.noCameraDevice')}
                </Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Camera
                style={StyleSheet.absoluteFill}
                device={device}
                isActive={true}
                codeScanner={codeScanner}
            />
            {/* 关闭按钮 */}
            <TouchableOpacity
                style={[styles.closeButton, { top: insets.top + 16 }]}
                onPress={handleClose}
            >
                <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
            {/* 扫描框 */}
            <View style={styles.overlay}>
                <View style={styles.scanFrame} />
            </View>
        </View>
    );
}

export default memo(ScannerScreen);

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    message: {
        fontSize: 16,
        textAlign: 'center',
        marginHorizontal: 32,
        marginTop: 100,
    },
    button: {
        marginTop: 24,
        backgroundColor: theme.colors.button.primary.background,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
        alignSelf: 'center',
    },
    buttonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 16,
        fontWeight: '600',
    },
    closeButton: {
        position: 'absolute',
        left: 16,
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
    },
    closeButtonText: {
        color: '#fff',
        fontSize: 20,
        fontWeight: 'bold',
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center',
        alignItems: 'center',
        pointerEvents: 'none',
    },
    scanFrame: {
        width: 250,
        height: 250,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.8)',
        borderRadius: 16,
    },
}));
