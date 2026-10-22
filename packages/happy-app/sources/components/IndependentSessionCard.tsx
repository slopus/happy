import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from './StyledText';
import { useSession } from '@/sync/storage';
import type { SessionLink } from '@/utils/sessionLinks';

export const IndependentSessionCard = React.memo(function IndependentSessionCard({ link }: { link: SessionLink }) {
    const session = useSession(link.sessionId);
    const navigateToSession = useNavigateToSession();
    const { theme } = useUnistyles();
    const status = session?.agentState?.turnStatus?.status;
    const waiting = Object.keys(session?.agentState?.requests ?? {}).length > 0;
    const label = !session ? '正在同步会话' : waiting ? '等待操作' : session.thinking || status === 'running' ? '处理中'
        : status === 'completed' ? '已完成' : status === 'failed' ? '执行失败' : status === 'cancelled' ? '已取消' : '已创建';
    return <Pressable accessibilityRole="button" accessibilityLabel={`打开会话：${link.title}`} testID={`independent-session-${link.sessionId}`}
        onPress={() => navigateToSession(link.sessionId)}
        style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
        <Ionicons name="chatbubble-outline" size={22} color={theme.colors.textSecondary} />
        <View style={styles.body}>
            <Text style={styles.title} numberOfLines={2}>{link.title}</Text>
            <Text style={styles.status}>{label}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
    </Pressable>;
});
const styles = StyleSheet.create(theme => ({
    card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, marginVertical: 6,
        backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 14 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    body: { flex: 1, gap: 4 },
    title: { color: theme.colors.text, fontSize: 16, fontWeight: '600' },
    status: { color: theme.colors.textSecondary, fontSize: 13 },
}));
