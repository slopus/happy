import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { Switch } from '@/components/Switch';
import { t } from '@/text';

export default function FeaturesSettingsScreen() {
    const { theme } = useUnistyles();
    const [experiments, setExperiments] = useSettingMutable('experiments');
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');
    const [agentInputEnterToSend, setAgentInputEnterToSend] = useSettingMutable('agentInputEnterToSend');
    const [markdownCopyV2, setMarkdownCopyV2] = useLocalSettingMutable('markdownCopyV2');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [expResumeSession, setExpResumeSession] = useSettingMutable('expResumeSession');
    const [fileDiffsSidebar, setFileDiffsSidebar] = useSettingMutable('fileDiffsSidebar');
    const [groupToolCalls, setGroupToolCalls] = useSettingMutable('groupToolCalls');
    const [expDesktopScreenshot, setExpDesktopScreenshot] = useSettingMutable('expDesktopScreenshot');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Interface */}
            <ItemGroup
                title={t('featuresInterface.title')}
                footer={t('featuresInterface.footer')}
            >
                <Item
                    title={t('featuresInterface.fileDiffsSidebar')}
                    subtitle={t('featuresInterface.fileDiffsSidebarSubtitle')}
                    icon={<Ionicons name="git-branch-outline" size={29} color="#5AC8FA" />}
                    rightElement={
                        <Switch
                            accessibilityLabel={t('featuresInterface.fileDiffsSidebar')}
                            value={fileDiffsSidebar}
                            onValueChange={setFileDiffsSidebar}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.groupToolCalls')}
                    subtitle={t('settingsFeatures.groupToolCallsSubtitle')}
                    icon={<Ionicons name="layers-outline" size={29} color="#AF52DE" />}
                    rightElement={
                        <Switch
                            accessibilityLabel={t('settingsFeatures.groupToolCalls')}
                            value={groupToolCalls}
                            onValueChange={setGroupToolCalls}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Experimental Features */}
            <ItemGroup
                title={t('settingsFeatures.experiments')}
                footer={t('settingsFeatures.experimentsDescription')}
            >
                <Item
                    title={t('settingsFeatures.experimentalFeatures')}
                    subtitle={experiments ? t('settingsFeatures.experimentalFeaturesEnabled') : t('settingsFeatures.experimentalFeaturesDisabled')}
                    icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            accessibilityLabel={t('settingsFeatures.experimentalFeatures')}
                            value={experiments}
                            onValueChange={setExperiments}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.markdownCopyV2')}
                    subtitle={t('settingsFeatures.markdownCopyV2Subtitle')}
                    icon={<Ionicons name="text-outline" size={29} color="#34C759" />}
                    rightElement={
                        <Switch
                            accessibilityLabel={t('settingsFeatures.markdownCopyV2')}
                            value={markdownCopyV2}
                            onValueChange={setMarkdownCopyV2}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                    icon={<Ionicons name="eye-off-outline" size={29} color="#FF9500" />}
                    rightElement={
                        <Switch
                            accessibilityLabel={t('settingsFeatures.hideInactiveSessions')}
                            value={hideInactiveSessions}
                            onValueChange={setHideInactiveSessions}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('featuresInterface.resumeSession')}
                    subtitle={t('featuresInterface.resumeSessionSubtitle')}
                    icon={<Ionicons name="play-circle-outline" size={29} color="#30D158" />}
                    rightElement={
                        <Switch
                            accessibilityLabel={t('featuresInterface.resumeSession')}
                            value={expResumeSession}
                            onValueChange={setExpResumeSession}
                        />
                    }
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.desktopScreenshot')}
                    subtitle={t('settingsFeatures.desktopScreenshotSubtitle')}
                    icon={<Ionicons name="camera-outline" size={29} color="#00C7BE" />}
                    rightElement={
                        <Switch
                            accessibilityLabel={t('settingsFeatures.desktopScreenshot')}
                            value={expDesktopScreenshot}
                            onValueChange={setExpDesktopScreenshot}
                        />
                    }
                    showChevron={false}
                />
                {/* 图片上传已转正为默认功能，不再作为实验开关展示 */}
            </ItemGroup>

            {/* Privacy */}
            <ItemGroup
                title={t('settingsFeatures.privacy')}
                footer={t('settingsFeatures.privacyDescription')}
            >
                <Item
                    title={t('settingsFeatures.disableAnalytics')}
                    subtitle={analyticsOptOut ? t('settingsFeatures.analyticsDisabled') : t('settingsFeatures.analyticsEnabled')}
                    icon={<Ionicons name="analytics-outline" size={29} color="#FF3B30" />}
                    rightElement={
                        <Switch
                            accessibilityLabel={t('settingsFeatures.disableAnalytics')}
                            value={analyticsOptOut}
                            onValueChange={setAnalyticsOptOut}
                        />
                    }
                    showChevron={false}
                />
            </ItemGroup>

            {/* Web-only Features */}
            {Platform.OS === 'web' && (
                <ItemGroup 
                    title={t('settingsFeatures.webFeatures')}
                    footer={t('settingsFeatures.webFeaturesDescription')}
                >
                    <Item
                        title={t('settingsFeatures.enterToSend')}
                        subtitle={agentInputEnterToSend ? t('settingsFeatures.enterToSendEnabled') : t('settingsFeatures.enterToSendDisabled')}
                        icon={<Ionicons name="return-down-forward-outline" size={29} color={theme.colors.accent} />}
                        rightElement={
                            <Switch
                                accessibilityLabel={t('settingsFeatures.enterToSend')}
                                value={agentInputEnterToSend}
                                onValueChange={setAgentInputEnterToSend}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
