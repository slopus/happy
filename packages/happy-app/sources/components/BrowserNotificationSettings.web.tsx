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
    const unavailable = permission === 'unsupported' || permission === 'insecure';
    const description = permission === 'denied'
        ? label('通知权限已被阻止，请在浏览器的网站设置中允许通知。', 'Notifications are blocked. Allow notifications in your browser’s site settings.')
        : permission === 'insecure'
            ? label('系统通知需要安全的 HTTPS 连接。', 'System notifications require a secure HTTPS connection.')
            : permission === 'unsupported'
                ? label('当前浏览器不支持系统通知。', 'This browser does not support system notifications.')
                : label('任务完成时显示系统通知，点击可返回对应会话。', 'Show a system notification when a task completes. Click it to return to the session.');
    return <ItemGroup title={label('浏览器系统通知', 'Browser notifications')} footer={label('只提醒新完成的任务，声音可单独开关。网页需保持打开并连接，切到后台也可接收。请同时在 macOS 系统设置中允许浏览器通知。', 'Only newly completed tasks are notified; sound is controlled separately. Keep this page open and connected, including in the background. Also allow browser notifications in macOS System Settings.')}>
        <Item
            title={label('任务完成通知', 'Task completion notifications')}
            subtitle={description}
            icon={<Ionicons name="notifications-outline" size={27} color={theme.colors.accent} />}
            rightElement={<Switch value={enabled && permission === 'granted'} disabled={busy || unavailable} onValueChange={async (value) => {
                setTestResult(null);
                if (!value) { setEnabled(false); return; }
                setBusy(true);
                try {
                    const result = await requestBrowserNotificationPermission();
                    setPermission(result);
                    setEnabled(result === 'granted');
                } finally { setBusy(false); }
            }} />}
            testID="web-completion-notification-enable"
        />
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
                ? label('已向浏览器发送测试通知，请检查系统通知。', 'Test notification sent to the browser. Check your system notifications.')
                : label('浏览器未能发送通知，请检查网站权限和系统通知设置。', 'The browser could not send the notification. Check site permissions and system notification settings.')}</Text>
        </View>}
    </ItemGroup>;
}
