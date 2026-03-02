import * as React from 'react';
import { Text, View, ScrollView, Pressable, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Typography, getFontPreference, setFontPreference, subscribeFontPreference, type FontPreference } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useLearnUser, useLearnStats, learnStorage } from '../learnStorage';
import { learnApi } from '../learnApi';

const isWeb = Platform.OS === 'web';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    statsRow: {
        flexDirection: 'row',
        padding: 16,
        gap: 10,
    },
    statCard: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        borderRadius: 12,
        backgroundColor: theme.colors.groupped.item,
    },
    statValue: {
        fontSize: 24,
        color: theme.colors.text,
        ...Typography.default('bold'),
    },
    statLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
}));

// ============ Pill Picker ============

function PillRow({
    label,
    options,
    value,
    onSelect,
}: {
    label: string;
    options: { label: string; value: number }[];
    value: number;
    onSelect: (v: number) => void;
}) {
    const { theme } = useUnistyles();

    return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
            <Text style={{
                fontSize: 13, color: theme.colors.textSecondary,
                marginBottom: 10,
                ...Typography.default('medium'),
            }}>
                {label}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {options.map((opt) => {
                    const active = opt.value === value;
                    return (
                        <Pressable
                            key={opt.value}
                            onPress={() => onSelect(opt.value)}
                            style={{
                                paddingHorizontal: 14, paddingVertical: 8,
                                borderRadius: 10,
                                backgroundColor: active
                                    ? theme.colors.text
                                    : theme.colors.textSecondary + '15',
                            }}
                        >
                            <Text style={{
                                fontSize: 13,
                                color: active
                                    ? theme.colors.groupped.background
                                    : theme.colors.textSecondary,
                                ...Typography.default(active ? 'semiBold' : 'regular'),
                            }}>
                                {opt.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

// ============ Font Picker ============

function useFontPreference(): FontPreference {
    const [pref, setPref] = React.useState(getFontPreference);
    React.useEffect(() => subscribeFontPreference(() => setPref(getFontPreference())), []);
    return pref;
}

const FONT_OPTIONS: { key: FontPreference; label: string; sample: string; desc: string }[] = [
    { key: 'plex', label: 'IBM Plex', sample: 'Aa', desc: 'Technical' },
    { key: 'system', label: 'System', sample: 'Aa', desc: 'SF Pro' },
    { key: 'inter', label: 'Inter', sample: 'Aa', desc: 'Modern' },
    { key: 'geist', label: 'Geist', sample: 'Aa', desc: 'Minimal' },
];

const _fontFamilyForPreview: Record<FontPreference, string> = {
    plex: 'IBMPlexSans-Regular',
    system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
    inter: '"Inter", -apple-system, sans-serif',
    geist: '"Geist", -apple-system, sans-serif',
};

function FontPicker() {
    const { theme } = useUnistyles();
    const currentFont = useFontPreference();

    const handleSelect = React.useCallback((key: FontPreference) => {
        if (key === currentFont) return;
        setFontPreference(key);
        // Reload to apply font globally (fonts are read at module init time)
        if (isWeb) {
            // Small delay for Google Fonts to start loading
            setTimeout(() => window.location.reload(), key === 'plex' || key === 'system' ? 100 : 500);
        }
    }, [currentFont]);

    return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
            <Text style={{
                fontSize: 13, color: theme.colors.textSecondary,
                marginBottom: 10,
                ...Typography.default('medium'),
            }}>
                Шрифт
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {FONT_OPTIONS.map((opt) => {
                    const active = currentFont === opt.key;
                    return (
                        <Pressable
                            key={opt.key}
                            onPress={() => handleSelect(opt.key)}
                            style={({ hovered }: any) => ({
                                width: '22%' as any,
                                minWidth: 70,
                                paddingVertical: 12,
                                paddingHorizontal: 8,
                                borderRadius: 12,
                                alignItems: 'center',
                                backgroundColor: active
                                    ? theme.colors.text + '12'
                                    : hovered ? theme.colors.text + '06' : theme.colors.textSecondary + '08',
                                borderWidth: 1.5,
                                borderColor: active ? theme.colors.text + '30' : 'transparent',
                                ...(isWeb ? { cursor: 'pointer', transition: 'all 0.15s ease' } as any : {}),
                            })}
                        >
                            <Text style={{
                                fontSize: 22, marginBottom: 4,
                                color: active ? theme.colors.text : theme.colors.textSecondary,
                                ...(isWeb ? { fontFamily: _fontFamilyForPreview[opt.key], fontWeight: '400' } as any : Typography.default()),
                            }}>
                                {opt.sample}
                            </Text>
                            <Text style={{
                                fontSize: 11,
                                color: active ? theme.colors.text : theme.colors.textSecondary,
                                ...Typography.default(active ? 'semiBold' : 'regular'),
                            }}>
                                {opt.label}
                            </Text>
                            <Text style={{
                                fontSize: 9, color: theme.colors.textSecondary, opacity: 0.6,
                                marginTop: 1,
                                ...Typography.default(),
                            }}>
                                {opt.desc}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

// ============ Settings ============

export const LearnSettingsView = React.memo(() => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const user = useLearnUser();
    const stats = useLearnStats();

    const settings = (user?.settings ?? {}) as Record<string, any>;

    const updateSetting = React.useCallback(async (key: string, value: number) => {
        const currentSettings = (learnStorage.getState().user?.settings ?? {}) as Record<string, any>;
        const newSettings = { ...currentSettings, [key]: value };
        // Optimistic update
        const currentUser = learnStorage.getState().user;
        if (currentUser) {
            learnStorage.getState().setUser({ ...currentUser, settings: newSettings });
        }
        try {
            await learnApi.updateSettings(newSettings);
        } catch (e) {
            console.error('Failed to update settings:', e);
            // Revert on error
            if (currentUser) {
                learnStorage.getState().setUser({ ...currentUser, settings: currentSettings });
            }
        }
    }, []);

    const retention = settings.desiredRetention ?? 0.9;
    const maxInterval = settings.maximumInterval ?? 365;
    const newCards = settings.newCardsPerDay ?? 0;
    const reviews = settings.reviewsPerDay ?? 0;

    return (
        <ScrollView style={styles.container}>
            {/* Stats cards */}
            <View style={styles.statsRow}>
                <View style={styles.statCard}>
                    <Text style={styles.statValue}>{stats?.currentStreak ?? 0}</Text>
                    <Text style={styles.statLabel}>Day streak</Text>
                </View>
                <View style={styles.statCard}>
                    <Text style={styles.statValue}>{stats?.totalXP ?? 0}</Text>
                    <Text style={styles.statLabel}>Total XP</Text>
                </View>
                <View style={styles.statCard}>
                    <Text style={styles.statValue}>{stats?.cardsMastered ?? 0}</Text>
                    <Text style={styles.statLabel}>Cards mastered</Text>
                </View>
            </View>

            {/* Account */}
            <ItemGroup title="Account">
                <Item
                    title={user?.name || 'User'}
                    subtitle={user?.email || ''}
                    icon={<Ionicons name="person-circle-outline" size={22} color={theme.colors.text} />}
                />
            </ItemGroup>

            {/* Appearance */}
            <ItemGroup title="Appearance">
                <Item
                    title="Theme"
                    icon={<Ionicons name="color-palette-outline" size={22} color={theme.colors.text} />}
                    onPress={() => router.push('/settings/appearance' as any)}
                    showChevron
                />
            </ItemGroup>

            {/* Font (web only) */}
            {isWeb && (
                <ItemGroup title="Типографика">
                    <FontPicker />
                </ItemGroup>
            )}

            {/* Flashcards */}
            <ItemGroup title="Карточки" footer="Выше % запоминания — чаще повторения, лучше запоминание">
                <PillRow
                    label="Целевое запоминание"
                    options={[
                        { label: '70%', value: 0.7 },
                        { label: '80%', value: 0.8 },
                        { label: '85%', value: 0.85 },
                        { label: '90%', value: 0.9 },
                        { label: '95%', value: 0.95 },
                    ]}
                    value={retention}
                    onSelect={(v) => updateSetting('desiredRetention', v)}
                />
                <View style={{ height: 1, backgroundColor: theme.colors.textSecondary + '15', marginHorizontal: 16 }} />
                <PillRow
                    label="Макс. интервал"
                    options={[
                        { label: '30 дн', value: 30 },
                        { label: '90 дн', value: 90 },
                        { label: '180 дн', value: 180 },
                        { label: '1 год', value: 365 },
                        { label: '2 года', value: 730 },
                    ]}
                    value={maxInterval}
                    onSelect={(v) => updateSetting('maximumInterval', v)}
                />
                <View style={{ height: 1, backgroundColor: theme.colors.textSecondary + '15', marginHorizontal: 16 }} />
                <PillRow
                    label="Новых карточек в день"
                    options={[
                        { label: '5', value: 5 },
                        { label: '10', value: 10 },
                        { label: '20', value: 20 },
                        { label: '50', value: 50 },
                        { label: '\u221E', value: 0 },
                    ]}
                    value={newCards}
                    onSelect={(v) => updateSetting('newCardsPerDay', v)}
                />
                <View style={{ height: 1, backgroundColor: theme.colors.textSecondary + '15', marginHorizontal: 16 }} />
                <PillRow
                    label="Повторений в день"
                    options={[
                        { label: '20', value: 20 },
                        { label: '50', value: 50 },
                        { label: '100', value: 100 },
                        { label: '200', value: 200 },
                        { label: '\u221E', value: 0 },
                    ]}
                    value={reviews}
                    onSelect={(v) => updateSetting('reviewsPerDay', v)}
                />
            </ItemGroup>

            {/* Learning */}
            <ItemGroup title="Learning stats">
                <Item
                    title="Courses completed"
                    detail={String(stats?.coursesCompleted ?? 0)}
                    icon={<Ionicons name="school-outline" size={22} color={theme.colors.text} />}
                />
                <Item
                    title="Courses in progress"
                    detail={String(stats?.coursesInProgress ?? 0)}
                    icon={<Ionicons name="book-outline" size={22} color={theme.colors.text} />}
                />
                <Item
                    title="Total cards"
                    detail={String(stats?.cardsTotal ?? 0)}
                    icon={<Ionicons name="layers-outline" size={22} color={theme.colors.text} />}
                />
                <Item
                    title="Longest streak"
                    detail={`${stats?.longestStreak ?? 0} days`}
                    icon={<Ionicons name="flame-outline" size={22} color={theme.colors.text} />}
                />
            </ItemGroup>

            <View style={{ height: 40 }} />
        </ScrollView>
    );
});
