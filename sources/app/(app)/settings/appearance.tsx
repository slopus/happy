import { View, Switch } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useSettingMutable } from '@/sync/storage';

export default function AppearanceSettingsScreen() {
    const [viewInline, setViewInline] = useSettingMutable('viewInline');
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Theme Settings */}
            {/* <ItemGroup title="Theme" footer="Choose your preferred color scheme">
                <Item
                    title="Appearance"
                    subtitle="Match system settings"
                    icon={<Ionicons name="contrast-outline" size={29} color="#007AFF" />}
                    detail="System"
                    onPress={() => { }}
                    disabled
                />
            </ItemGroup> */}

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
            <ItemGroup title="Display" footer="Control layout and spacing">
                <Item
                    title="Inline Tool Calls"
                    subtitle="Display tool calls directly in chat messages"
                    icon={<Ionicons name="code-slash-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={viewInline}
                            onValueChange={setViewInline}
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#fff"
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
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#fff"
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
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#fff"
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