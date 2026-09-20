import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { type StyleProp, type ViewStyle } from 'react-native';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { useAllMachines } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';
import { shouldShowOfflineMachinesBanner } from './onboarding/firstRunOnboarding';
import { t } from '@/text';

/**
 * A quiet plaque at the top of the session list when every linked computer
 * is offline. Same slot and shape as the update banner, so it reads as a
 * notice rather than an alarm; the warning glyph is what says which kind.
 */
export const OfflineMachinesBanner = React.memo(({
    style,
    headerStyle,
}: {
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
}) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const choices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const onlineCount = choices.filter((choice) => choice.online).length;

    if (!shouldShowOfflineMachinesBanner({ machineCount: choices.length, onlineMachineCount: onlineCount })) {
        return null;
    }

    const title = choices.length === 1
        ? t('troubleshoot.bannerTitleOne', { name: choices[0].name })
        : t('troubleshoot.bannerTitleMany');

    return (
        <ItemGroup style={style} headerStyle={headerStyle}>
            <Item
                title={title}
                subtitle={t('troubleshoot.bannerSubtitle')}
                icon={<Ionicons name="warning-outline" size={28} color={theme.colors.box.warning.text} />}
                showChevron={true}
                onPress={() => router.push('/troubleshoot')}
            />
        </ItemGroup>
    );
});
