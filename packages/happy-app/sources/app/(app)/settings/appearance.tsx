import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { StyleSheet, useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Appearance, Platform, Pressable, Text, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { type SessionListGrouping } from '@/sync/settings';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import {
    normalizeUserMessageBubbleColor,
    resolveUserMessageBubbleColor,
    resolveUserMessageBubbleGlassColor,
    USER_MESSAGE_BUBBLE_COLORS,
    type UserMessageBubbleColor,
} from '@/utils/userMessageBubbleColor';
import * as React from 'react';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { AnimatedCollapsible } from '@/components/AnimatedOverlay';
import { AvatarBrutalist } from '@/components/AvatarBrutalist';
import { AvatarSkia } from '@/components/AvatarSkia';
import { AvatarGradient } from '@/components/AvatarGradient';
import { AVATAR_STYLES, normalizeAvatarStyle, type AvatarStyle } from '@/utils/avatarStyle';

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

const getAvatarStyleLabel = (style: AvatarStyle): string => {
    switch (style) {
        case 'brutalist':
            return t('settingsAppearance.avatarStyleOptions.brutalist');
        case 'pixelated':
            return t('settingsAppearance.avatarStyleOptions.pixelated');
        case 'gradient':
            return t('settingsAppearance.avatarStyleOptions.gradient');
    }
};

// One fixed id so the three previews stay comparable: same seed, different
// renderer.
const AVATAR_PREVIEW_ID = 'avatar-style-preview';

function AvatarStylePreview({ style, monochrome }: { style: AvatarStyle; monochrome: boolean }) {
    const size = 28;
    switch (style) {
        case 'brutalist':
            return <AvatarBrutalist id={AVATAR_PREVIEW_ID} size={size} monochrome={monochrome} />;
        case 'pixelated':
            return <AvatarSkia id={AVATAR_PREVIEW_ID} size={size} monochrome={monochrome} />;
        case 'gradient':
            return <AvatarGradient id={AVATAR_PREVIEW_ID} size={size} monochrome={monochrome} />;
    }
}

function AvatarStyleDropdownValue(props: {
    style: AvatarStyle;
    monochrome: boolean;
    expanded: boolean;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.dropdownValue}>
            <AvatarStylePreview style={props.style} monochrome={props.monochrome} />
            <Text style={styles.dropdownValueText} numberOfLines={1}>
                {getAvatarStyleLabel(props.style)}
            </Text>
            <Ionicons
                name={props.expanded ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={theme.colors.groupped.chevron}
            />
        </View>
    );
}

function AvatarStyleOption(props: {
    style: AvatarStyle;
    monochrome: boolean;
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
            <AvatarStylePreview style={props.style} monochrome={props.monochrome} />
            <Text style={styles.statusPlacementOptionText} numberOfLines={1}>
                {getAvatarStyleLabel(props.style)}
            </Text>
            {props.selected ? (
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.status.connecting} />
            ) : (
                <View style={styles.bubbleColorOptionCheckPlaceholder} />
            )}
        </Pressable>
    );
}

const getSessionListGroupingLabel = (mode: SessionListGrouping): string => {
    switch (mode) {
        case 'flat':
            return t('sessionsFilter.flatList');
        case 'project':
            return t('sessionsFilter.groupByProject');
    }
};

function BubbleColorPreview({ color }: { color: UserMessageBubbleColor }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const palette = resolveUserMessageBubbleColor(color, theme.dark);
    const glassPalette = resolveUserMessageBubbleGlassColor(color, theme.dark);
    const glassEnabled = Platform.OS !== 'web';

    return (
        <MobileGlassSurface
            enabled={glassEnabled}
            tintColor={glassEnabled ? glassPalette.tint : undefined}
            style={[
                styles.bubblePreview,
                {
                    backgroundColor: glassEnabled ? glassPalette.background : palette.background,
                    borderColor: glassEnabled ? glassPalette.border : palette.border,
                },
            ]}
        >
            <View style={[styles.bubblePreviewLine, { backgroundColor: palette.indicator, width: 18 }]} />
            <View style={[styles.bubblePreviewLine, { backgroundColor: palette.indicator, width: 26 }]} />
        </MobileGlassSurface>
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
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [showHarnessIconInSessionHeader, setShowHarnessIconInSessionHeader] = useSettingMutable('showHarnessIconInSessionHeader');
    const [compactToolCalls, setCompactToolCalls] = useSettingMutable('compactToolCalls');
    const [userMessageBubbleColor, setUserMessageBubbleColor] = useSettingMutable('userMessageBubbleColor');
    const [usageLimitShowRemaining, setUsageLimitShowRemaining] = useSettingMutable('usageLimitShowRemaining');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [avatarStyleSetting, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [avatarMonochrome, setAvatarMonochrome] = useSettingMutable('avatarMonochrome');
    const [sessionListGrouping, setSessionListGrouping] = useSettingMutable('sessionListGrouping');
    const [bubbleColorDropdownOpen, setBubbleColorDropdownOpen] = React.useState(false);
    const [avatarStyleDropdownOpen, setAvatarStyleDropdownOpen] = React.useState(false);

    const avatarStyle = normalizeAvatarStyle(avatarStyleSetting);
    const displayBubbleColor = normalizeUserMessageBubbleColor(userMessageBubbleColor);
    const displayBubblePalette = resolveUserMessageBubbleColor(displayBubbleColor, theme.dark);
    const displayBubbleColorLabel = getUserMessageBubbleColorLabel(displayBubbleColor);
    
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

                        // Keep the NATIVE appearance in step: SwiftUI menus,
                        // the keyboard, and native context menus follow UIKit,
                        // not unistyles (see unistyles.ts).
                        if (Platform.OS !== 'web') {
                            Appearance.setColorScheme(nextTheme === 'adaptive' ? 'unspecified' : nextTheme);
                        }
                        
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
                    title={t('settingsAppearance.usageLimitShowRemaining')}
                    subtitle={t('settingsAppearance.usageLimitShowRemainingDescription')}
                    icon={<Ionicons name="speedometer-outline" size={29} color={theme.colors.status.connecting} />}
                    rightElement={
                        <Switch
                            value={usageLimitShowRemaining}
                            onValueChange={setUsageLimitShowRemaining}
                        />
                    }
                />
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
                        setAvatarStyleDropdownOpen(false);
                        setBubbleColorDropdownOpen((open) => !open);
                    }}
                    showDivider={bubbleColorDropdownOpen}
                />
                {bubbleColorDropdownOpen && (
                    <AnimatedCollapsible style={stylesheet.bubbleColorDropdown}>
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
                    </AnimatedCollapsible>
                )}
            </ItemGroup>

            {/* Avatar Settings */}
            <ItemGroup title={t('settingsAppearance.avatars')} footer={t('settingsAppearance.avatarsDescription')}>
                <Item
                    title={t('settingsAppearance.avatarStyle')}
                    icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.status.connecting} />}
                    rightElement={
                        <AvatarStyleDropdownValue
                            style={avatarStyle}
                            monochrome={avatarMonochrome}
                            expanded={avatarStyleDropdownOpen}
                        />
                    }
                    onPress={() => {
                        setBubbleColorDropdownOpen(false);
                        setAvatarStyleDropdownOpen((open) => !open);
                    }}
                    showDivider={avatarStyleDropdownOpen}
                />
                {avatarStyleDropdownOpen && (
                    <AnimatedCollapsible style={stylesheet.statusPlacementDropdown}>
                        {AVATAR_STYLES.map((style) => (
                            <AvatarStyleOption
                                key={style}
                                style={style}
                                monochrome={avatarMonochrome}
                                selected={style === avatarStyle}
                                onPress={() => {
                                    setAvatarStyle(style);
                                    setAvatarStyleDropdownOpen(false);
                                }}
                            />
                        ))}
                    </AnimatedCollapsible>
                )}
                <Item
                    title={t('settingsAppearance.avatarMonochrome')}
                    subtitle={t('settingsAppearance.avatarMonochromeDescription')}
                    icon={<Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />}
                    rightElement={
                        <Switch
                            value={avatarMonochrome}
                            onValueChange={setAvatarMonochrome}
                        />
                    }
                />
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
            <ItemGroup title={t('settingsAppearance.input')} footer={t('settingsAppearance.inputDescription')}>
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
            </ItemGroup>

            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                {/* Same setting the home filter menu drives; two values, so a
                    tap flips between them like the theme row does. */}
                <Item
                    title={t('sessionsFilter.groupingTitle')}
                    icon={<Ionicons name="list-outline" size={29} color="#5856D6" />}
                    detail={getSessionListGroupingLabel(sessionListGrouping === 'project' ? 'project' : 'flat')}
                    onPress={() => {
                        setSessionListGrouping(sessionListGrouping === 'project' ? 'flat' : 'project');
                    }}
                />
                <Item
                    title={t('settingsAppearance.compactToolCalls')}
                    subtitle={t('settingsAppearance.compactToolCallsDescription')}
                    icon={<Ionicons name="contract-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={compactToolCalls}
                            onValueChange={setCompactToolCalls}
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
                    title={t('settingsAppearance.showHarnessIconInSessionHeader')}
                    subtitle={t('settingsAppearance.showHarnessIconInSessionHeaderDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={showHarnessIconInSessionHeader}
                            onValueChange={setShowHarnessIconInSessionHeader}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showHarnessIconsInSessionList')}
                    subtitle={t('settingsAppearance.showHarnessIconsInSessionListDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                        />
                    }
                />
                {/* <Item
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
        backgroundColor: Platform.select({ web: theme.colors.surfaceSelected, default: theme.colors.glass.backgroundSubtle }),
    },
    statusPlacementOptionPressed: {
        backgroundColor: Platform.select({ web: theme.colors.surfacePressedOverlay, default: theme.colors.glass.backgroundStrong }),
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
        backgroundColor: Platform.select({ web: theme.colors.surfaceSelected, default: theme.colors.glass.backgroundSubtle }),
    },
    bubbleColorOptionPressed: {
        backgroundColor: Platform.select({ web: theme.colors.surfacePressedOverlay, default: theme.colors.glass.backgroundStrong }),
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
        overflow: 'hidden',
    },
    bubblePreviewLine: {
        height: 3,
        borderRadius: 999,
    },
}));
