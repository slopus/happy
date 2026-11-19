import * as React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { Switch } from './Switch';
import { useLocalSettingMutable } from '@/sync/storage';
import { getCurrentLanguage } from '@/text';
import { getBrowserNotificationPermission, requestBrowserNotificationPermission, previewBrowserNotification } from '@/sync/webCompletionNotifications.web';

export function BrowserNotificationSettings() {
    const { theme } = useUnistyles();
    const [enabled, setEnabled] = useLocalSettingMutable('webCompletionNotificationsEnabled');
    const [permission, setPermission] = React.useState(getBrowserNotificationPermission);
    const [busy, setBusy] = React.useState(false);
    const [testResult, setTestResult] = React.useState<boolean | null>(null);
    const label = (zh: string, en: string) => getCurrentLanguage().startsWith('zh') ? zh : en;
    React.useEffect(() => {
        const refresh = () => setPermission(getBrowserNotificationPermission());
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, []);
    const requestPermission = async () => {
        setTestResult(null);
        setBusy(true);
        try { setPermission(await requestBrowserNotificationPermission()); }
        finally { setBusy(false); }
    };
    const unavailable = permission === 'unsupported' || permission === 'insecure';
    const description = permission === 'denied'
        ? label('通知权限已被阻止，请在浏览器的网站设置中允许通知。', 'Notifications are blocked. Allow notifications in your browser’s site settings.')
        : permission === 'insecure'
            ? label('系统通知需要安全的 HTTPS 连接。', 'System notifications require a secure HTTPS connection.')
            : permission === 'unsupported'
                ? label('当前浏览器不支持系统通知。', 'This browser does not support system notifications.')
                : permission === 'default'
                    ? (enabled
                        ? label('默认开启；还需点击下方“允许浏览器通知”完成首次授权。', 'On by default. Click Allow browser notifications below to grant permission first.')
                        : label('已关闭。开启后还需允许浏览器通知。', 'Off. Enable this setting and allow browser notifications to receive alerts.'))
                    : label('浏览器已授权。任务完成时发送系统通知，点击可返回会话。', 'Browser permission granted. Task completion notifications link back to the session.');
    return <ItemGroup title={label('浏览器系统通知', 'Browser notifications')} footer={label('只提醒新完成的任务，声音可单独开关。网页需保持打开并连接，切到后台也可接收；应用开关和浏览器、系统权限分别控制。', 'Only newly completed tasks are notified; sound is controlled separately. Keep this page open and connected, including in the background. The app setting, browser permission and system settings are separate.')}>
        <Item
            title={label('任务完成通知', 'Task completion notifications')}
            subtitle={description}
            icon={<Ionicons name="notifications-outline" size={27} color={theme.colors.accent} />}
            rightElement={<Switch value={enabled} disabled={busy || unavailable} onValueChange={async (value) => {
                setTestResult(null);
                setEnabled(value);
                // The preference is independent of permission. Do not turn it
                // off when a permission prompt is dismissed or denied.
                if (value && permission === 'default') await requestPermission();
            }} />}
            testID="web-completion-notification-enable"
        />
        {enabled && permission === 'default' && <Item
            title={label('允许浏览器通知', 'Allow browser notifications')}
            subtitle={label('首次授权需在浏览器弹窗中选择“允许”。', 'Choose Allow in the browser’s permission prompt.')}
            onPress={() => { void requestPermission(); }}
            disabled={busy}
            showChevron={false}
            testID="web-completion-notification-permission"
        />}
        {permission === 'granted' && <Item
            title={label('已授权，但没有弹出横幅？', 'Permission granted, but no banner?')}
            subtitle={label('macOS：系统设置 → 通知 → 当前浏览器，将通知样式设为“横幅”或“提醒”，并检查专注模式。通知中心有记录，不代表已允许横幅。', 'macOS: System Settings → Notifications → your browser. Choose Banners or Alerts and check Focus. A notification can appear in Notification Center without a banner.')}
            showChevron={false}
            testID="web-completion-notification-system-help"
        />}
        <Item
            title={label('发送测试通知', 'Send a test notification')}
            subtitle={label('未看到横幅？检查 macOS 通知设置或专注模式。', 'No banner? Check macOS notification settings or Focus mode.')}
            onPress={permission === 'granted' ? () => setTestResult(previewBrowserNotification()) : undefined}
            disabled={permission !== 'granted'}
            showChevron={false}
            testID="web-completion-notification-test"
        />
        {testResult !== null && <View style={{ paddingHorizontal: 18, paddingBottom: 12 }}>
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary }}>{testResult
                ? label('已提交测试通知；是否弹出横幅由系统通知样式和专注模式决定。', 'Test notification submitted. Banners depend on your system notification style and Focus settings.')
                : label('浏览器未能发送通知，请检查网站权限和系统通知设置。', 'The browser could not send the notification. Check site permissions and system notification settings.')}</Text>
        </View>}
    </ItemGroup>;
}
