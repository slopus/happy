import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { StyleSheet, useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Appearance, Pressable, Text, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { SESSION_STATUS_INFO_PLACEMENTS, type SessionStatusInfoPlacement } from '@/sync/settings';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import {
    normalizeUserMessageBubbleColor,
    resolveUserMessageBubbleColor,
    USER_MESSAGE_BUBBLE_COLORS,
    type UserMessageBubbleColor,
} from '@/utils/userMessageBubbleColor';
import * as React from 'react';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'pixelated' | 'gradient' | 'brutalist';

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

const getUserMessageBubbleColorLabel = (color: UserMessageBubbleColor): string => {
    switch (color) {
        case 'blue':
            return t('settingsAppearance.userMessageBubbleColorOptions.blue');
        case 'green':
            return t('settingsAppearance.userMessageBubbleColorOptions.green');
        case 'purple':
            return t('settingsAppearance.userMessageBubbleColorOptions.purple');
        case 'rose':
            return t('settingsAppearance.userMessageBubbleColorOptions.rose');
        case 'sand':
            return t('settingsAppearance.userMessageBubbleColorOptions.sand');
        case 'gray':
            return t('settingsAppearance.userMessageBubbleColorOptions.gray');
    }
};

const getSessionStatusPlacementLabel = (placement: SessionStatusInfoPlacement): string => {
    switch (placement) {
        case 'composer':
            return t('settingsAppearance.sessionStatusPlacementOptions.composer');
        case 'gearbox':
            return t('settingsAppearance.sessionStatusPlacementOptions.gearbox');
    }
};

function BubbleColorPreview({ color }: { color: UserMessageBubbleColor }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const palette = resolveUserMessageBubbleColor(color, theme.dark);

    return (
        <View style={[styles.bubblePreview, { backgroundColor: palette.background, borderColor: palette.border }]}>
            <View style={[styles.bubblePreviewLine, { backgroundColor: palette.indicator, width: 18 }]} />
            <View style={[styles.bubblePreviewLine, { backgroundColor: palette.indicator, width: 26 }]} />
        </View>
    );
}

function BubbleColorDropdownValue(props: {
    color: UserMessageBubbleColor;
    label: string;
    expanded: boolean;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.dropdownValue}>
            <BubbleColorPreview color={props.color} />
            <Text style={styles.dropdownValueText} numberOfLines={1}>
                {props.label}
            </Text>
            <Ionicons
                name={props.expanded ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={theme.colors.groupped.chevron}
            />
        </View>
    );
}

function StatusPlacementDropdownValue(props: {
    placement: SessionStatusInfoPlacement;
    expanded: boolean;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.dropdownValue}>
            <Text style={styles.dropdownValueText} numberOfLines={1}>
                {getSessionStatusPlacementLabel(props.placement)}
            </Text>
            <Ionicons
                name={props.expanded ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={theme.colors.groupped.chevron}
            />
        </View>
    );
}

function StatusPlacementOption(props: {
    placement: SessionStatusInfoPlacement;
    selected: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.statusPlacementOption,
                props.selected && styles.statusPlacementOptionSelected,
                pressed && styles.statusPlacementOptionPressed,
            ]}
        >
            <Ionicons
                name={props.placement === 'composer' ? 'reorder-three-outline' : 'settings-outline'}
                size={20}
                color={props.selected ? theme.colors.status.connecting : theme.colors.textSecondary}
            />
            <Text style={styles.statusPlacementOptionText} numberOfLines={1}>
                {getSessionStatusPlacementLabel(props.placement)}
            </Text>
            {props.selected ? (
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.status.connecting} />
            ) : (
                <View style={styles.bubbleColorOptionCheckPlaceholder} />
            )}
        </Pressable>
    );
}

function BubbleColorOption(props: {
    color: UserMessageBubbleColor;
    selected: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.bubbleColorOption,
                props.selected && styles.bubbleColorOptionSelected,
                pressed && styles.bubbleColorOptionPressed,
            ]}
        >
            <BubbleColorPreview color={props.color} />
            <Text style={styles.bubbleColorOptionText} numberOfLines={1}>
                {getUserMessageBubbleColorLabel(props.color)}
            </Text>
            {props.selected ? (
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.status.connecting} />
            ) : (
                <View style={styles.bubbleColorOptionCheckPlaceholder} />
            )}
        </Pressable>
    );
}

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [viewInline, setViewInline] = useSettingMutable('viewInline');
    const [expandTodos, setExpandTodos] = useSettingMutable('expandTodos');
    const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [wrapLinesInDiffs, setWrapLinesInDiffs] = useSettingMutable('wrapLinesInDiffs');
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [userMessageBubbleColor, setUserMessageBubbleColor] = useSettingMutable('userMessageBubbleColor');
    const [sessionStatusInfoPlacement, setSessionStatusInfoPlacement] = useSettingMutable('sessionStatusInfoPlacement');
    const [, setShowSessionStatusBar] = useSettingMutable('showSessionStatusBar');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [statusPlacementDropdownOpen, setStatusPlacementDropdownOpen] = React.useState(false);
    const [bubbleColorDropdownOpen, setBubbleColorDropdownOpen] = React.useState(false);
    
    // Ensure we have a valid style for display, defaulting to gradient for unknown values
    const displayStyle: KnownAvatarStyle = isKnownAvatarStyle(avatarStyle) ? avatarStyle : 'gradient';
    const displayBubbleColor = normalizeUserMessageBubbleColor(userMessageBubbleColor);
    const displayBubblePalette = resolveUserMessageBubbleColor(displayBubbleColor, theme.dark);
    const displayBubbleColorLabel = getUserMessageBubbleColorLabel(displayBubbleColor);
    const applySessionStatusPlacement = React.useCallback((placement: SessionStatusInfoPlacement) => {
        setSessionStatusInfoPlacement(placement);
        setShowSessionStatusBar(placement === 'composer');
        setStatusPlacementDropdownOpen(false);
    }, [setSessionStatusInfoPlacement, setShowSessionStatusBar]);
    
    // Language display
    const getLanguageDisplayText = () => {
        if (preferredLanguage === null) {
            const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
            const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
            const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES ? 
                                        getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES) : 
                                        getLanguageNativeName('en');
            return `${t('settingsLanguage.automatic')} (${detectedLanguageName})`;
        } else if (preferredLanguage && preferredLanguage in SUPPORTED_LANGUAGES) {
            return getLanguageNativeName(preferredLanguage as keyof typeof SUPPORTED_LANGUAGES);
        }
        return t('settingsLanguage.automatic');
    };
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
                        
                        // Update the setting
                        setThemePreference(nextTheme);
                        
                        // Apply the theme change immediately
                        if (nextTheme === 'adaptive') {
                            // Enable adaptive themes and set to system theme
                            UnistylesRuntime.setAdaptiveThemes(true);
                            const systemTheme = Appearance.getColorScheme();
                            const color = systemTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
                            UnistylesRuntime.setRootViewBackgroundColor(color);
                            SystemUI.setBackgroundColorAsync(color);
                        } else {
                            // Disable adaptive themes and set explicit theme
                            UnistylesRuntime.setAdaptiveThemes(false);
                            UnistylesRuntime.setTheme(nextTheme);
                            const color = nextTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
                            UnistylesRuntime.setRootViewBackgroundColor(color);
                            SystemUI.setBackgroundColorAsync(color);
                        }
                    }}
                />
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup title={t('settingsLanguage.title')} footer={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsAppearance.chat')} footer={t('settingsAppearance.chatDescription')}>
                <Item
                    title={t('settingsAppearance.sessionStatusBar')}
                    subtitle={t('settingsAppearance.sessionStatusBarDescription')}
                    icon={<Ionicons name="stats-chart-outline" size={29} color={theme.colors.status.connecting} />}
                    rightElement={
                        <StatusPlacementDropdownValue
                            placement={sessionStatusInfoPlacement}
                            expanded={statusPlacementDropdownOpen}
                        />
                    }
                    onPress={() => {
                        setBubbleColorDropdownOpen(false);
                        setStatusPlacementDropdownOpen((open) => !open);
                    }}
                    showDivider={statusPlacementDropdownOpen}
                />
                {statusPlacementDropdownOpen && (
                    <View style={stylesheet.statusPlacementDropdown}>
                        {SESSION_STATUS_INFO_PLACEMENTS.map((placement) => (
                            <StatusPlacementOption
                                key={placement}
                                placement={placement}
                                selected={placement === sessionStatusInfoPlacement}
                                onPress={() => applySessionStatusPlacement(placement)}
                            />
                        ))}
                    </View>
                )}
                <Item
                    title={t('settingsAppearance.userMessageBubbleColor')}
                    subtitle={t('settingsAppearance.userMessageBubbleColorDescription')}
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color={displayBubblePalette.indicator} />}
                    rightElement={
                        <BubbleColorDropdownValue
                            color={displayBubbleColor}
                            label={displayBubbleColorLabel}
                            expanded={bubbleColorDropdownOpen}
                        />
                    }
                    onPress={() => {
                        setStatusPlacementDropdownOpen(false);
                        setBubbleColorDropdownOpen((open) => !open);
                    }}
                    showDivider={bubbleColorDropdownOpen}
                />
                {bubbleColorDropdownOpen && (
                    <React.Fragment>
                        <View style={stylesheet.bubbleColorDropdown}>
                            {USER_MESSAGE_BUBBLE_COLORS.map((color) => (
                                <BubbleColorOption
                                    key={color}
                                    color={color}
                                    selected={color === displayBubbleColor}
                                    onPress={() => {
                                        setUserMessageBubbleColor(color);
                                        setBubbleColorDropdownOpen(false);
                                    }}
                                />
                            ))}
                        </View>
                    </React.Fragment>
                )}
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
                    icon={<Ionicons name="code-slash-outline" size={29} color="#5856D6" />}
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

const stylesheet = StyleSheet.create((theme) => ({
    dropdownValue: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: 184,
    },
    dropdownValueText: {
        color: theme.colors.textSecondary,
        fontSize: 15,
        flexShrink: 1,
    },
    bubbleColorDropdown: {
        paddingVertical: 6,
    },
    statusPlacementDropdown: {
        paddingVertical: 6,
    },
    statusPlacementOption: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
    },
    statusPlacementOptionSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    statusPlacementOptionPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    statusPlacementOptionText: {
        color: theme.colors.text,
        fontSize: 16,
        flex: 1,
    },
    bubbleColorOption: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
    },
    bubbleColorOptionSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    bubbleColorOptionPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    bubbleColorOptionText: {
        color: theme.colors.text,
        fontSize: 16,
        flex: 1,
    },
    bubbleColorOptionCheckPlaceholder: {
        width: 20,
        height: 20,
    },
    bubblePreview: {
        width: 46,
        height: 28,
        borderRadius: 14,
        borderWidth: 1,
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 9,
    },
    bubblePreviewLine: {
        height: 3,
        borderRadius: 999,
    },
}));
