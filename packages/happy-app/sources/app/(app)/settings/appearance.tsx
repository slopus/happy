import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { DesktopSkinPicker } from '@/components/DesktopSkinPicker';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { applyTheme } from '@/unistyles';
import { runThemeTransition } from '@/components/ThemeTransition';
import { GradientIcon } from '@/components/GradientIcon';
import { ACCENTS } from '@/themePacks';
import { Typography } from '@/constants/Typography';
import { Platform, Pressable, View, Text } from 'react-native';
import { Image } from 'expo-image';
import { MASCOT_IDS, getMascotImage, getMascotName, getMascotTheme } from '@/components/mascots';
import { t } from '@/text';
import { useIsTablet } from '@/utils/responsive';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'pixelated' | 'gradient' | 'brutalist';

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const [viewInline, setViewInline] = useSettingMutable('viewInline');
    const [expandTodos, setExpandTodos] = useSettingMutable('expandTodos');
    const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [wrapLinesInDiffs, setWrapLinesInDiffs] = useSettingMutable('wrapLinesInDiffs');
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [themePack, setThemePack] = useLocalSettingMutable('themePack');
    const [desktopSkinId, setDesktopSkinId] = useLocalSettingMutable('desktopSkinId');
    const [mascot, setMascot] = useLocalSettingMutable('mascot');
    const [hapticFeedbackEnabled, setHapticFeedbackEnabled] = useLocalSettingMutable('hapticFeedbackEnabled');

    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle: KnownAvatarStyle = isKnownAvatarStyle(avatarStyle) ? avatarStyle : 'gradient';
    
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Theme Settings */}
            <ItemGroup title={t('settingsAppearance.theme')} footer={t('settingsAppearance.themeDescription')}>
                <Item
                    title={t('settings.appearance')}
                    subtitle={themePreference === 'adaptive' ? t('settingsAppearance.themeDescriptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeDescriptions.light') : t('settingsAppearance.themeDescriptions.dark')}
                    icon={<Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />}
                    detail={themePreference === 'adaptive' ? t('settingsAppearance.themeOptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeOptions.light') : t('settingsAppearance.themeOptions.dark')}
                    onPress={() => {
                        const currentIndex = themePreference === 'adaptive' ? 0 : themePreference === 'light' ? 1 : 2;
                        const nextIndex = (currentIndex + 1) % 3;
                        const nextTheme = nextIndex === 0 ? 'adaptive' : nextIndex === 1 ? 'light' : 'dark';
                        
                        // 带 crossfade 过渡切换明暗
                        runThemeTransition(() => {
                            setThemePreference(nextTheme);
                            applyTheme(themePack, nextTheme);
                        });
                    }}
                    testID="appearance-theme-preference"
                />
                {/* 主题配色包选择器 — 一排色板，点选即切换 */}
                <View style={styles.swatchRow}>
                    {ACCENTS.map((acc) => {
                        const selected = acc.id === themePack;
                        return (
                            <Pressable
                                key={acc.id}
                                testID={`appearance-theme-pack-${acc.id}`}
                                style={styles.swatchItem}
                                onPress={() => runThemeTransition(() => {
                                    setThemePack(acc.id as typeof themePack);
                                    applyTheme(acc.id as typeof themePack, themePreference);
                                })}
                            >
                                <View style={[
                                    styles.swatchCircle,
                                    { backgroundColor: acc.swatch.primary },
                                    selected && { borderColor: theme.colors.text, borderWidth: 3 },
                                ]}>
                                    {selected && <Ionicons name="checkmark" size={18} color={acc.light.onPrimary} />}
                                </View>
                                <Text style={[styles.swatchLabel, { color: selected ? theme.colors.text : theme.colors.textSecondary }]}>
                                    {acc.id.charAt(0).toUpperCase() + acc.id.slice(1)}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </ItemGroup>

            {Platform.OS === 'web' && isTablet && (
                <ItemGroup title={t('settingsAppearance.desktopSkinTitle')} footer={t('settingsAppearance.desktopSkinDescription')}>
                    <DesktopSkinPicker
                        value={desktopSkinId}
                        onChange={(next) => runThemeTransition(() => {
                            setDesktopSkinId(next);
                            applyTheme(themePack, themePreference);
                        })}
                    />
                </ItemGroup>
            )}

            {/* 吉祥物选择器 — 一排土拨鼠形象，点选即切换，空状态页/设置头部实时跟随 */}
            <ItemGroup title={t('settingsAppearance.mascot')} footer={t('settingsAppearance.mascotDescription')}>
                <View style={styles.mascotRow}>
                    {MASCOT_IDS.map((id) => {
                        const selected = id === mascot;
                        return (
                            <Pressable
                                key={id}
                                style={styles.mascotItem}
                                onPress={() => runThemeTransition(() => {
                                    // 选吉祥物即联动切换它绑定的主题配色（带 crossfade 过渡；色板仍保留可微调）
                                    setMascot(id);
                                    const pack = getMascotTheme(id);
                                    setThemePack(pack as typeof themePack);
                                    applyTheme(pack as typeof themePack, themePreference);
                                })}
                            >
                                <View style={[
                                    styles.mascotCard,
                                    { backgroundColor: theme.colors.surfaceHigh },
                                    selected && { borderColor: theme.colors.text, borderWidth: 2 },
                                ]}>
                                    <Image
                                        source={getMascotImage(id)}
                                        style={{ width: 56, height: 56 }}
                                        contentFit="contain"
                                    />
                                    {selected && (
                                        <View style={[styles.mascotCheck, { backgroundColor: theme.colors.text }]}>
                                            <Ionicons name="checkmark" size={12} color={theme.colors.surface} />
                                        </View>
                                    )}
                                </View>
                                <Text
                                    numberOfLines={1}
                                    style={[styles.mascotLabel, { color: selected ? theme.colors.text : theme.colors.textSecondary }]}
                                >
                                    {getMascotName(id)}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </ItemGroup>

            {/* Text Settings */}
            {/* <ItemGroup title="Text" footer="Adjust text size and font preferences">
                <Item
                    title="Text Size"
                    subtitle="Make text larger or smaller"
                    icon={<Ionicons name="text-outline" size={29} color="#FF9500" />}
                    detail="Default"
                    onPress={() => { }}
                    disabled
                />
                <Item
                    title="Font"
                    subtitle="Choose your preferred font"
                    icon={<Ionicons name="text-outline" size={29} color="#FF9500" />}
                    detail="System"
                    onPress={() => { }}
                    disabled
                />
            </ItemGroup> */}

            {/* Display Settings */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <Item
                    title={t('settingsAppearance.inlineToolCalls')}
                    subtitle={t('settingsAppearance.inlineToolCallsDescription')}
                    icon={<GradientIcon name="code-slash" colors={['#7B8CFF', '#5856D6']} />}
                    rightElement={
                        <Switch
                            value={viewInline}
                            onValueChange={setViewInline}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.expandTodoLists')}
                    subtitle={t('settingsAppearance.expandTodoListsDescription')}
                    icon={<Ionicons name="checkmark-done-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={expandTodos}
                            onValueChange={setExpandTodos}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.hapticFeedback')}
                    subtitle={t('settingsAppearance.hapticFeedbackDescription')}
                    icon={<Ionicons name="phone-portrait-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={hapticFeedbackEnabled}
                            onValueChange={setHapticFeedbackEnabled}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInDiffs')}
                    subtitle={t('settingsAppearance.showLineNumbersInDiffsDescription')}
                    icon={<Ionicons name="list-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={showLineNumbers}
                            onValueChange={setShowLineNumbers}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInToolViews')}
                    subtitle={t('settingsAppearance.showLineNumbersInToolViewsDescription')}
                    icon={<Ionicons name="code-working-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={showLineNumbersInToolViews}
                            onValueChange={setShowLineNumbersInToolViews}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.wrapLinesInDiffs')}
                    subtitle={t('settingsAppearance.wrapLinesInDiffsDescription')}
                    icon={<Ionicons name="return-down-forward-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={wrapLinesInDiffs}
                            onValueChange={setWrapLinesInDiffs}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.diffStyle')}
                    subtitle={t('settingsAppearance.diffStyleDescription')}
                    icon={<Ionicons name="git-compare-outline" size={29} color="#5856D6" />}
                    detail={diffStyle === 'split' ? t('settingsAppearance.diffStyleOptions.split') : t('settingsAppearance.diffStyleOptions.unified')}
                    onPress={() => setDiffStyle(diffStyle === 'unified' ? 'split' : 'unified')}
                />
                <Item
                    title={t('settingsAppearance.alwaysShowContextSize')}
                    subtitle={t('settingsAppearance.alwaysShowContextSizeDescription')}
                    icon={<Ionicons name="analytics-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={alwaysShowContextSize}
                            onValueChange={setAlwaysShowContextSize}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.avatarStyle')}
                    subtitle={t('settingsAppearance.avatarStyleDescription')}
                    icon={<Ionicons name="person-circle-outline" size={29} color="#5856D6" />}
                    detail={displayStyle === 'pixelated' ? t('settingsAppearance.avatarOptions.pixelated') : displayStyle === 'brutalist' ? t('settingsAppearance.avatarOptions.brutalist') : t('settingsAppearance.avatarOptions.gradient')}
                    onPress={() => {
                        const currentIndex = displayStyle === 'pixelated' ? 0 : displayStyle === 'gradient' ? 1 : 2;
                        const nextIndex = (currentIndex + 1) % 3;
                        const nextStyle = nextIndex === 0 ? 'pixelated' : nextIndex === 1 ? 'gradient' : 'brutalist';
                        setAvatarStyle(nextStyle);
                    }}
                />
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={t('settingsAppearance.showFlavorIconsDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                        />
                    }
                />
                {/* <Item
                    title="Compact Mode"
                    subtitle="Reduce spacing between elements"
                    icon={<Ionicons name="contract-outline" size={29} color="#5856D6" />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                        />
                    }
                />
                <Item
                    title="Show Avatars"
                    subtitle="Display user and assistant avatars"
                    icon={<Ionicons name="person-circle-outline" size={29} color="#5856D6" />}
                    disabled
                    rightElement={
                        <Switch
                            value={true}
                            disabled
                        />
                    }
                /> */}
            </ItemGroup>

            {/* Colors */}
            {/* <ItemGroup title="Colors" footer="Customize accent colors and highlights">
                <Item
                    title="Accent Color"
                    subtitle="Choose your accent color"
                    icon={<Ionicons name="color-palette-outline" size={29} color="#FF3B30" />}
                    detail="Blue"
                    onPress={() => { }}
                    disabled
                />
            </ItemGroup> */}
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    swatchRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
        paddingHorizontal: 18,
        paddingVertical: 16,
        backgroundColor: theme.colors.surface,
    },
    swatchItem: {
        alignItems: 'center',
        width: 56,
    },
    swatchCircle: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        borderColor: 'transparent',
        borderWidth: 0,
    },
    swatchLabel: {
        ...Typography.default(),
        fontSize: 11,
        marginTop: 6,
    },
    mascotRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 14,
        paddingHorizontal: 18,
        paddingVertical: 16,
        backgroundColor: theme.colors.surface,
    },
    mascotItem: {
        alignItems: 'center',
        width: 72,
    },
    mascotCard: {
        width: 68,
        height: 68,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderColor: 'transparent',
        borderWidth: 0,
    },
    mascotCheck: {
        position: 'absolute',
        top: -4,
        right: -4,
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    mascotLabel: {
        ...Typography.default(),
        fontSize: 11,
        marginTop: 6,
        textAlign: 'center',
    },
}));
