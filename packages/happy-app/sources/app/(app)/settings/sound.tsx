import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useLocalSettingMutable } from '@/sync/storage';
import { previewWebSound, WEB_SOUND_CHOICES, type SoundChoice } from '@/sync/webSoundAlerts';
import { getCurrentLanguage } from '@/text';
import type { WebSoundSettingsSchema } from '@/sync/localSettings';
import type * as z from 'zod';

type SoundSettings = z.infer<typeof WebSoundSettingsSchema>;
type SoundEvent = keyof SoundSettings['sounds'];

const EVENTS: { key: SoundEvent; title: [string, string]; detail: [string, string] }[] = [
    { key: 'started', title: ['会话开始', 'Session started'], detail: ['新一轮任务开始执行', 'A new turn starts running'] },
    { key: 'completed', title: ['本轮完成', 'Turn completed'], detail: ['AI 已完成这一轮回复', 'The AI finished this turn'] },
    { key: 'failed', title: ['执行失败', 'Turn failed'], detail: ['整轮任务失败或发生错误', 'The whole turn failed'] },
    { key: 'permission', title: ['等待授权', 'Approval needed'], detail: ['需要你批准工具操作', 'A tool needs your approval'] },
    { key: 'question', title: ['等待回答', 'Answer needed'], detail: ['需要你回答问题', 'The AI needs your answer'] },
];

const CHOICE_NAMES: Record<SoundChoice, [string, string]> = {
    off: ['关闭', 'Off'], approval: ['提醒', 'Alert'], complete: ['完成', 'Complete'],
    error: ['错误', 'Error'], start: ['开始', 'Start'], submit: ['确认', 'Confirm'],
};

export default function SoundSettingsScreen() {
    const { theme } = useUnistyles();
    const [settings, setSettings] = useLocalSettingMutable('webSound');
    const [expanded, setExpanded] = React.useState<SoundEvent | null>(null);
    const [playbackBlocked, setPlaybackBlocked] = React.useState(false);
    const languageIndex = getCurrentLanguage().startsWith('zh') ? 0 : 1;
    const label = (chinese: string, english: string) => languageIndex === 0 ? chinese : english;

    const update = React.useCallback((delta: Partial<SoundSettings>) => {
        setSettings({ ...settings, ...delta });
    }, [settings, setSettings]);

    const preview = React.useCallback(async (choice: SoundChoice) => {
        if (choice === 'off') {
            setPlaybackBlocked(false);
            return;
        }
        setPlaybackBlocked(!(await previewWebSound(choice, settings.volume)));
    }, [settings.volume]);

    if (Platform.OS !== 'web') return null;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={label('声音提醒', 'Sound alerts')} footer={label('声音设置只保存在当前浏览器。首次启用请点击试听，以允许浏览器播放声音。', 'Sound settings stay in this browser. Click Preview once to allow playback.')}>
                <Item
                    title={label('开启声音提醒', 'Enable sound alerts')}
                    subtitle={label('任务完成、失败或需要你处理时播放', 'Play for completion, failure, and requests for your attention')}
                    icon={<Ionicons name="volume-medium-outline" size={27} color={theme.colors.accent} />}
                    rightElement={<Switch value={settings.enabled} onValueChange={(enabled) => {
                        update({ enabled });
                        if (enabled) void preview(settings.sounds.completed);
                    }} />}
                    testID="web-sound-enable"
                />
                <View style={{ paddingHorizontal: 18, paddingVertical: 12 }}>
                    <Text style={{ color: theme.colors.text, fontSize: 15 }}>{label('音量', 'Volume')} · {Math.round(settings.volume * 100)}%</Text>
                    <Slider
                        testID="web-sound-volume"
                        minimumValue={0}
                        maximumValue={1}
                        step={0.05}
                        value={settings.volume}
                        minimumTrackTintColor={theme.colors.accent}
                        maximumTrackTintColor={theme.colors.surfacePressed}
                        onSlidingComplete={(volume) => update({ volume })}
                    />
                </View>
                {playbackBlocked && <View style={{ paddingHorizontal: 18, paddingBottom: 12 }}>
                    <Text style={{ color: theme.colors.textSecondary }}>{label('浏览器未能播放音效。请检查标签页是否静音，然后点击右侧试听按钮。', 'The browser could not play the sound. Check whether this tab is muted, then click Preview again.')}</Text>
                </View>}
            </ItemGroup>

            <ItemGroup title={label('提醒范围', 'Alert scope')}>
                {([
                    ['all', '所有会话', 'All sessions'], ['current', '当前会话', 'Current session'], ['pinned', '置顶会话', 'Pinned sessions'],
                ] as const).map(([scope, chinese, english]) => (
                    <Item
                        key={scope}
                        title={label(chinese, english)}
                        icon={<Ionicons name={settings.scope === scope ? 'radio-button-on' : 'radio-button-off'} size={22} color={theme.colors.accent} />}
                        onPress={() => update({ scope })}
                        showChevron={false}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: settings.scope === scope }}
                        testID={`web-sound-scope-${scope}`}
                    />
                ))}
                <Item
                    title={label('正在查看的会话静音', 'Mute the viewed session')}
                    subtitle={label('浏览器当前正在显示该会话时不响铃', 'Stay quiet when you are looking at that session')}
                    rightElement={<Switch value={settings.muteViewedSession} onValueChange={(muteViewedSession) => update({ muteViewedSession })} />}
                />
            </ItemGroup>

            <ItemGroup title={label('会话与交互', 'Session and interaction')} footer={label('一次工具调用失败不会触发“执行失败”；刷新页面也不会补播历史事件。', 'A single tool failure does not ring an error. Refreshing does not replay old events.')}>
                {EVENTS.map(({ key, title, detail }) => (
                    <React.Fragment key={key}>
                        <Item
                            title={title[languageIndex]}
                            subtitle={detail[languageIndex]}
                            detail={CHOICE_NAMES[settings.sounds[key]][languageIndex]}
                            onPress={() => setExpanded(expanded === key ? null : key)}
                            rightElement={<Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`${label('试听', 'Preview')} ${title[languageIndex]}`}
                                testID={`web-sound-preview-${key}`}
                                onPress={(event) => {
                                    event.stopPropagation();
                                    void preview(settings.sounds[key]);
                                }}
                                style={{ padding: 8 }}
                            ><Ionicons name="play-circle-outline" size={25} color={theme.colors.accent} /></Pressable>}
                            testID={`web-sound-event-${key}`}
                        />
                        {expanded === key && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12, backgroundColor: theme.colors.surfacePressed }}>
                            {WEB_SOUND_CHOICES.map((choice) => {
                                const selected = settings.sounds[key] === choice;
                                return <Pressable
                                    key={choice}
                                    accessibilityRole="radio"
                                    accessibilityState={{ checked: selected }}
                                    testID={`web-sound-choice-${key}-${choice}`}
                                    onPress={() => {
                                        update({ sounds: { ...settings.sounds, [key]: choice } });
                                        if (choice !== 'off') void preview(choice);
                                    }}
                                    style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, backgroundColor: selected ? theme.colors.surfaceSelected : theme.colors.surface }}
                                ><Text style={{ color: theme.colors.text }}>{CHOICE_NAMES[choice][languageIndex]}</Text></Pressable>;
                            })}
                        </View>}
                    </React.Fragment>
                ))}
            </ItemGroup>
        </ItemList>
    );
}
