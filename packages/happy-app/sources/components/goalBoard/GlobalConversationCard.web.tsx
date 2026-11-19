import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { GoalBoardCard } from './GoalBoardCard';
import { GoalBoardButton } from './GoalBoardButton';
import type { GlobalConversationCardProps } from './GlobalConversationCard';

const css = `@keyframes paws-global-glare{0%,25%{transform:translateX(-180%) skewX(-22deg);opacity:0}40%{opacity:1}65%,100%{transform:translateX(360%) skewX(-22deg);opacity:0}}
.paws-global-glare{animation:paws-global-glare 7s ease-in-out infinite}
@media(prefers-reduced-motion:reduce){.paws-global-glare{animation:none;opacity:0}}`;

export function GlobalConversationCard({ selected, busy, onPress }: GlobalConversationCardProps) {
    const { theme } = useUnistyles();
    return <GoalBoardCard selected={selected} style={styles.card} testID="project-global-card">
        <style>{css}</style>
        <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: `linear-gradient(135deg, color-mix(in srgb, ${theme.colors.textLink} 10%, transparent), transparent 70%)` }} />
        <div aria-hidden className="paws-global-glare" style={{ position: 'absolute', inset: '-30% auto -30% 0', width: '45%', pointerEvents: 'none', background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${theme.colors.textLink} 18%, transparent), transparent)` }} />
        <GoalBoardButton variant="card" label={t('projectGoals.globalConversation')} selected={selected} disabled={busy} busy={busy} onPress={onPress} testID="project-global-card-open">
            <View style={styles.content}>
                <View style={styles.header}><Ionicons name="planet-outline" size={18} color={theme.colors.textLink} /><Text style={styles.eyebrow}>{t('projectGoals.globalConversationCompact')}</Text></View>
                <Text style={styles.title}>{t('projectGoals.globalConversation')}</Text>
                <Text numberOfLines={3} style={styles.description}>{t('projectGoals.globalCardHint')}</Text>
                <View style={styles.footer}><Text style={styles.link}>{t('projectGoals.chooseChat')}</Text>{busy ? <ActivityIndicator size="small" color={theme.colors.textLink} /> : <Ionicons name="arrow-forward-outline" size={17} color={theme.colors.textLink} />}</View>
            </View>
        </GoalBoardButton>
    </GoalBoardCard>;
}
const styles = StyleSheet.create(theme => ({
    card: { width: 248, maxWidth: '100%', minHeight: 230, flexGrow: 0, flexShrink: 0, borderColor: theme.colors.textLink },
    content: { flex: 1, width: '100%', padding: 16, gap: 10 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
    eyebrow: { fontSize: 10, letterSpacing: 1.2, color: theme.colors.textLink, ...Typography.default('semiBold') },
    title: { fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
    description: { fontSize: 12, lineHeight: 21, color: theme.colors.textSecondary, ...Typography.default() },
    footer: { marginTop: 'auto', paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.colors.divider, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    link: { fontSize: 12, lineHeight: 20, color: theme.colors.textLink, ...Typography.default() },
}));
