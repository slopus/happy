import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useLocalSettingMutable } from '@/sync/storage';
import { t } from '@/text';

export default function NotificationSettingsScreen() {
    const [hideNotificationsWhenActive, setHideNotificationsWhenActive] = useLocalSettingMutable('hideNotificationsWhenActive');
    const [hideSessionNotificationsWhenActive, setHideSessionNotificationsWhenActive] = useLocalSettingMutable('hideSessionNotificationsWhenActive');
    const disableSessionToggle = hideNotificationsWhenActive;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsNotifications.title')}
                footer={t('settingsNotifications.footer')}
            >
                <Item
                    title={t('settingsNotifications.hideAllTitle')}
                    subtitle={t('settingsNotifications.hideAllSubtitle')}
                    icon={<Ionicons name="notifications-off-outline" size={29} color="#FF3B30" />}
                    rightElement={(
                        <Switch
                            value={hideNotificationsWhenActive}
                            onValueChange={setHideNotificationsWhenActive}
                        />
                    )}
                    showChevron={false}
                />
                <Item
                    title={t('settingsNotifications.hideSessionTitle')}
                    subtitle={t('settingsNotifications.hideSessionSubtitle')}
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={29} color="#007AFF" />}
                    rightElement={(
                        <Switch
                            value={hideSessionNotificationsWhenActive}
                            onValueChange={setHideSessionNotificationsWhenActive}
                            disabled={disableSessionToggle}
                        />
                    )}
                    disabled={disableSessionToggle}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
}
