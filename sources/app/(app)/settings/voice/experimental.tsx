import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useSettingMutable } from '@/sync/storage';
import { t } from '@/text';

export default function ExperimentalVoiceSettings() {
    const [localVAD, setLocalVAD] = useSettingMutable('experimentalLocalVAD');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsVoice.experimental.title')}
                footer={t('settingsVoice.experimental.localVADDescription')}
            >
                <Item
                    title={t('settingsVoice.experimental.localVAD')}
                    subtitle={t('settingsVoice.experimental.localVADDescription')}
                    icon={<Ionicons name="mic-outline" size={29} color="#FF9500" />}
                    rightElement={
                        <Switch
                            value={localVAD}
                            onValueChange={setLocalVAD}
                        />
                    }
                />
            </ItemGroup>
        </ItemList>
    );
}