import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { applyOtaTarget } from '@/hooks/useOtaTarget';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { InvalidRouteState } from '@/components/InvalidRouteState';
import { t } from '@/text';

// Deep link 处理页：扫「OTA 版本浏览站」上的二维码 → paws://ota-switch?channel=preview&stamp=<stamp>
// 唤起此页 → 弹确认 → setExtraParamAsync 锁定该版本 → check/fetch → reload。
// 只接受 preview 频道 + 纯数字 stamp（与 FC 端白名单一致），其余展示可恢复的错误状态，不做任何切换。

function readSearchParam(value: string | string[] | undefined): string {
    return typeof value === 'string' ? value : '';
}

export function isValidOtaSwitchParams(channel: string, stamp: string): boolean {
    return channel === 'preview' && /^\d+$/.test(stamp);
}

export const OtaSwitchScreen = React.memo(function OtaSwitchScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ channel?: string | string[]; stamp?: string | string[] }>();
    const handledRef = React.useRef(false);
    const channel = readSearchParam(params.channel);
    const stamp = readSearchParam(params.stamp);
    const isValidTarget = isValidOtaSwitchParams(channel, stamp);

    React.useEffect(() => {
        if (!isValidTarget) return;
        if (handledRef.current) return;
        handledRef.current = true;

        (async () => {
            const confirmed = await Modal.confirm(
                '切换 OTA 版本？',
                `即将把本设备锁定到 preview 频道版本：\nstamp ${stamp}\n\n确认后会立即拉取目标包并重载，仅影响本设备。`,
                { confirmText: '拉取并切换', cancelText: '取消' },
            );
            if (!confirmed) {
                router.back();
                return;
            }
            try {
                await applyOtaTarget(stamp); // 重载后此页面不再返回
            } catch (e) {
                await Modal.alert('无法切换', e instanceof Error ? e.message : String(e));
                router.back();
            }
        })();
    }, [isValidTarget, router, stamp]);

    const handleInvalidLinkRecovery = React.useCallback(() => {
        router.replace('/dev/ota-versions' as any);
    }, [router]);

    if (!isValidTarget) {
        return (
            <InvalidRouteState
                title={t('terminal.invalidConnectionLink')}
                description={t('terminal.invalidConnectionLinkDescription')}
                actionLabel={t('devTools.otaVersions')}
                onAction={handleInvalidLinkRecovery}
            />
        );
    }

    return (
        <View style={styles.container}>
            <Ionicons name="swap-horizontal-outline" size={48} color={theme.colors.textSecondary} />
            <Text style={styles.processingText}>
                正在处理版本切换…
            </Text>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} style={styles.spinner} />
        </View>
    );
});

export default OtaSwitchScreen;

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        padding: theme.margins.xl,
    },
    processingText: {
        ...Typography.default(),
        color: theme.colors.text,
        marginTop: theme.margins.lg,
        fontSize: 16,
    },
    spinner: {
        marginTop: theme.margins.md,
    },
}));
