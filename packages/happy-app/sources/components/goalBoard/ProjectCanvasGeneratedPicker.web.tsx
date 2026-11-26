import * as React from 'react';
import { Modal, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { WebModalBackdrop } from '@/components/WebModalBackdrop';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';
import { getCurrentLanguage, t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import type { ProjectCanvasGeneratedResult } from './projectCanvasGeneratedImages';

export function ProjectCanvasGeneratedPicker({ results, onSelect, onClose }: {
    results: readonly ProjectCanvasGeneratedResult[];
    onSelect: (ref: string) => void;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const title = t('projectCanvas.generatedResultsTitle');
    const time = React.useMemo(() => new Intl.DateTimeFormat(getCurrentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }), []);
    useProjectModalEscape(onClose);

    return <Modal visible transparent animationType="none" onRequestClose={onClose} accessibilityLabel={title}>
        <View style={styles.backdrop}>
            <WebModalBackdrop onClose={onClose} testID="project-canvas-generated-picker-backdrop" />
            <View accessibilityViewIsModal style={[styles.dialog, { width: Math.min(420, width - 24), maxHeight: Math.floor(height * 0.74) }]}
                testID="project-canvas-generated-picker">
                <View style={styles.header}>
                    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
                    <Button variant="icon" label={t('common.cancel')} onPress={onClose} testID="project-canvas-generated-picker-close">
                        <Ionicons name="close-outline" size={19} color={theme.colors.textSecondary} />
                    </Button>
                </View>
                <ScrollView style={styles.scroll} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
                    {results.map((result, index) => {
                        const date = Number.isFinite(result.createdAt) && Math.abs(result.createdAt) <= 8.64e15 ? time.format(result.createdAt) : undefined;
                        return <Button key={result.ref} variant="row" label={result.name}
                            onPress={() => onSelect(result.ref)} testID={`project-canvas-generated-result-${index}`}>
                            <Ionicons name="image-outline" size={18} color={theme.colors.textSecondary} />
                            <View style={styles.copy}>
                                <Text numberOfLines={2} style={styles.name}>{result.name}</Text>
                                {date && <Text style={styles.date}>{date}</Text>}
                            </View>
                            <Ionicons name="add-outline" size={18} color={theme.colors.textLink} />
                        </Button>;
                    })}
                </ScrollView>
            </View>
        </View>
    </Modal>;
}

const styles = StyleSheet.create(theme => ({
    backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.modal.backdrop },
    dialog: {
        flexShrink: 1, minHeight: 0, overflow: 'hidden', borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface,
        boxShadow: `0 12px 40px ${theme.colors.shadow.color}`,
    },
    header: {
        minHeight: 48, paddingLeft: 14, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 8,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider,
    },
    title: { flex: 1, fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
    scroll: { minHeight: 0, flexGrow: 0, flexShrink: 1 },
    list: { padding: 8, gap: 4 },
    copy: { flex: 1, minWidth: 0, gap: 3 },
    name: { fontSize: 13, lineHeight: 18, color: theme.colors.text, ...Typography.default() },
    date: { fontSize: 11, lineHeight: 15, color: theme.colors.textSecondary, ...Typography.default() },
}));
