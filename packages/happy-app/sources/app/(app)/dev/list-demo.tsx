import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';

export default function ListDemoScreen() {
    const [isEnabled, setIsEnabled] = React.useState(false);
    const [selectedItem, setSelectedItem] = React.useState<string | null>(null);

    return (
        <ItemList>
            {/* Basic Items */}
            <ItemGroup title="Basic Items">
                <Item title="Simple Item" />
                <Item 
                    title="Item with Subtitle" 
                    subtitle="This is a subtitle that can span multiple lines if needed"
                />
                <Item 
                    title="Item with Detail" 
                    detail="Detail"
                />
                <Item 
                    title="Clickable Item"
                    onPress={() => console.log('Item pressed')}
                />
            </ItemGroup>

            {/* Items with Icons */}
            <ItemGroup title="With Icons">
                <Item 
                    title="Settings"
                    icon={<Ionicons name="settings-outline" size={28} color="#007AFF" />}
                    onPress={() => {}}
                />
                <Item 
                    title="Notifications"
                    icon={<Ionicons name="notifications-outline" size={28} color="#FF9500" />}
                    detail="5"
                    onPress={() => {}}
                />
                <Item 
                    title="Privacy"
                    icon={<Ionicons name="lock-closed-outline" size={28} color="#34C759" />}
                    subtitle="Control your privacy settings"
                    onPress={() => {}}
                />
            </ItemGroup>

            {/* Interactive Items */}
            <ItemGroup title="Interactive" footer="These items demonstrate various interactive states and elements">
                <Item 
                    title="Toggle Switch"
                    rightElement={
                        <Switch
                            value={isEnabled}
                            onValueChange={setIsEnabled}
                        />
                    }
                    showChevron={false}
                />
                <Item 
                    title="Selected Item"
                    selected={selectedItem === 'item1'}
                    onPress={() => setSelectedItem('item1')}
                />
                <Item 
                    title="Loading State"
                    loading={true}
                    onPress={() => {}}
                />
                <Item 
                    title="Disabled Item"
                    disabled={true}
                    onPress={() => {}}
                />
                <Item 
                    title="Destructive Action"
                    destructive={true}
                    onPress={() => {}}
                />
            </ItemGroup>

            {/* Custom Styling */}
            <ItemGroup title="Custom Styling">
                <Item 
                    title="Custom Colors"
                    subtitle="With custom text colors"
                    titleStyle={{ color: '#FF3B30' }}
                    subtitleStyle={{ color: '#FF9500' }}
                    onPress={() => {}}
                />
                <Item 
                    title="No Divider"
                    showDivider={false}
                />
                <Item 
                    title="Custom Inset"
                    dividerInset={60}
                />
                <Item 
                    title="No Chevron"
                    showChevron={false}
                    onPress={() => {}}
                />
            </ItemGroup>

            {/* Long Press */}
            <ItemGroup title="Gestures">
                <Item 
                    title="Long Press Me"
                    subtitle="Try long pressing this item"
                    onLongPress={() => console.log('Long pressed!')}
                />
                <Item 
                    title="Press and Long Press"
                    onPress={() => console.log('Pressed')}
                    onLongPress={() => console.log('Long pressed')}
                />
            </ItemGroup>
        </ItemList>
    );
}