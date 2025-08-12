import { Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';

export default function FeaturesSettingsScreen() {
    const [experiments, setExperiments] = useSettingMutable('experiments');
    
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
                            trackColor={{ false: '#767577', true: '#34C759' }}
                            thumbColor="#FFFFFF"
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
}