import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { t } from '@/text';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'pixelated' | 'gradient' | 'brutalist';

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const [viewInline, setViewInline] = useSettingMutable('viewInline');
    const [expandTodos, setExpandTodos] = useSettingMutable('expandTodos');
    const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    
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