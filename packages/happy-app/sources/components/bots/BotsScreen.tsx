import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { DrawerActions, useIsFocused } from '@react-navigation/native';
import { useNavigation } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BotsLaunchResponseSchema } from '@slopus/happy-wire';
import { useAuth } from '@/auth/AuthContext';
import { useSetting } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { useIsTablet } from '@/utils/responsive';
import { Text } from '@/components/StyledText';
import { t } from '@/text';
import { BotsFrame } from './BotsFrame';

type Launch = { runtimeUrl: string; ticket: string; expiresAt: number };
type Runtime = { owner: string; launch: Launch; generation: number };

export function BotsScreen() {
    const { credentials } = useAuth();
    const token = credentials?.token;
    const focused = useIsFocused();
    const tablet = useIsTablet();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    const language = useSetting('preferredLanguage');
    const locale = language?.startsWith('zh') ? 'zh' : 'en';
    const appearance = theme.dark ? 'dark' : 'light';
    const [attempt, setAttempt] = React.useState(0);
    const [runtime, setRuntime] = React.useState<Runtime | null>(null);
    const [authenticated, setAuthenticated] = React.useState(false);
    const [error, setError] = React.useState(false);
    const generation = React.useRef(0);
    const owner = React.useRef(token);
    owner.current = token;

    React.useEffect(() => {
        const current = ++generation.current;
        const abort = new AbortController();
        setRuntime(null); setAuthenticated(false); setError(false);
        if (!focused || !token) return () => abort.abort();
        const timeout = setTimeout(() => {
            if (generation.current === current && !abort.signal.aborted) setError(true);
            abort.abort();
        }, 45_000);
        const parentOrigin = Platform.OS === 'web' ? window.location.origin : new URL(getServerUrl()).origin;
        void fetch(`${getServerUrl()}/v1/bots/launch`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentOrigin, platform: Platform.OS === 'web' ? 'web' : 'native', locale, appearance }),
            signal: abort.signal,
        }).then(async response => {
            if (!response.ok) throw new Error('Bots launch unavailable');
            const launch = BotsLaunchResponseSchema.parse(await response.json());
            const url = new URL(launch.runtimeUrl);
            const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
            if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || launch.expiresAt <= Date.now()) throw new Error('Invalid Bots origin');
            if (!abort.signal.aborted && generation.current === current) setRuntime({ owner: token, launch, generation: current });
        }).catch(() => {
            if (!abort.signal.aborted && generation.current === current) setError(true);
        }).finally(() => clearTimeout(timeout));
        return () => { clearTimeout(timeout); abort.abort(); generation.current++; };
    }, [focused, token, attempt, locale, appearance]);

    // Account switches must hide the previous frame synchronously, before effects run.
    const visible = focused && runtime?.owner === token ? runtime : null;
    const isCurrent = React.useCallback(() => !!visible && visible.owner === owner.current && visible.generation === generation.current, [visible]);
    const connected = React.useCallback(() => { if (isCurrent()) setAuthenticated(true); }, [isCurrent]);
    const failed = React.useCallback(() => { if (isCurrent()) setError(true); }, [isCurrent]);
    React.useEffect(() => {
        if (!visible || authenticated || error) return;
        const timer = setTimeout(() => { if (isCurrent()) setError(true); }, 45_000);
        return () => clearTimeout(timer);
    }, [visible, authenticated, error, isCurrent]);
    return <View style={styles.screen} testID="bots-screen">
        <View style={styles.header}>
            {!tablet && <Pressable accessibilityRole="button" accessibilityLabel={t('bots.openMenu')} onPress={() => navigation.dispatch(DrawerActions.openDrawer())} style={styles.icon}><Feather name="menu" size={21} color={theme.colors.text} /></Pressable>}
            <Feather name="cpu" size={20} color={theme.colors.text} /><Text style={styles.title}>{t('bots.title')}</Text>
            <View style={styles.spacer} />
            <Pressable accessibilityRole="button" accessibilityLabel={t('bots.reconnect')} onPress={() => setAttempt(value => value + 1)} style={({ pressed }) => [styles.icon, pressed && styles.pressed]} testID="bots-reconnect"><Feather name="refresh-cw" size={18} color={theme.colors.textSecondary} /></Pressable>
        </View>
        <View style={styles.body}>
            {visible && !error && <BotsFrame key={visible.generation} {...visible.launch} onAuthenticated={connected} onFailure={failed} />}
            {(!authenticated || error) && <View style={styles.overlay} pointerEvents={error ? 'auto' : 'none'}>
                {error ? <>
                    <Feather name="cloud-off" size={28} color={theme.colors.textSecondary} />
                    <Text style={styles.message} accessibilityRole="alert">{t('bots.unavailable')}</Text>
                    <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={({ pressed }) => [styles.retry, pressed && styles.pressed]} testID="bots-retry"><Text style={styles.message}>{t('common.retry')}</Text></Pressable>
                </> : <><ActivityIndicator color={theme.colors.textSecondary} /><Text style={styles.message}>{t('bots.connecting')}</Text></>}
            </View>}
        </View>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    screen: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface },
    header: { height: 60, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    title: { color: theme.colors.text, fontSize: 17, fontWeight: '600' },
    spacer: { flex: 1 },
    icon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    body: { flex: 1, minHeight: 0 },
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
    message: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 22, textAlign: 'center' },
    retry: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: theme.colors.surface },
}));
