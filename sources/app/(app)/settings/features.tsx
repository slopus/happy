import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { Switch } from '@/components/Switch';

export default function FeaturesSettingsScreen() {
    const [experiments, setExperiments] = useSettingMutable('experiments');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    
    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Experimental Features */}
            <ItemGroup 
                title="Experiments" 
                footer="Enable experimental features that are still in development. These features may be unstable or change without notice."
            >
                <Item
                    title="Experimental Features"
                    subtitle={experiments ? "Experimental features enabled" : "Using stable features only"}
                    icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={experiments}
                            onValueChange={setExperiments}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Web-only Features */}
            {Platform.OS === 'web' && (
                <ItemGroup 
                    title="Web Features" 
                    footer="Features available only in the web version of the app."
                >
                    <Item
                        title="Command Palette"
                        subtitle={commandPaletteEnabled ? "Press ⌘K to open" : "Quick command access disabled"}
                        icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
                        rightElement={
                            <Switch
                                value={commandPaletteEnabled}
                                onValueChange={setCommandPaletteEnabled}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}