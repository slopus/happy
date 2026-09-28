import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { BrowserProgressContext } from './BrowserProgressContext';
import { BrowserStepsPopover, type BrowserStepsAnchorRect } from './rightPanel/BrowserStepsPopover';
import type { BrowserStepRun } from './rightPanel/browserStepRunsModel';

const selectionKey = (run: BrowserStepRun) => JSON.stringify([run.invocationMessageId, run.skillName, run.id]);

/** A sibling action, never nested inside the Skill diagnostic button. */
export function SkillBrowserProgress(props: { invocationMessageIds: string[] }) {
    const context = React.useContext(BrowserProgressContext);
    const runs = React.useMemo(() => context?.runs.filter(run =>
        props.invocationMessageIds.includes(run.invocationMessageId)) ?? [],
    [context?.runs, props.invocationMessageIds]);
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const [anchor, setAnchor] = React.useState<BrowserStepsAnchorRect>();
    const refs = React.useRef(new Map<string, View>());
    const selected = runs.find(run => selectionKey(run) === selectedId);
    React.useEffect(() => { setSelectedId(null); }, [context?.sessionId, context?.scopeKey]);
    React.useEffect(() => {
        if (selectedId && !selected) setSelectedId(null);
    }, [selectedId, selected]);

    if (!context || (!context.sessionId && !context.scopeKey) || runs.length === 0) return null;
    return <>
        <View style={styles.actions}>
            {runs.map((run, index) => <Pressable
                key={selectionKey(run)}
                ref={node => { if (node) refs.current.set(selectionKey(run), node); else refs.current.delete(selectionKey(run)); }}
                testID={`browser-progress-trigger-${run.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${t('rightPanelCapabilityHub.browserProgress.view')}: ${run.skillName}${runs.length > 1 ? ` ${index + 1}/${runs.length}` : ''}`}
                accessibilityState={{ expanded: selectedId === selectionKey(run) }}
                aria-expanded={selectedId === selectionKey(run)}
                aria-controls={`browser-progress-dialog-${run.id}`}
                onPress={() => {
                    const node = refs.current.get(selectionKey(run));
                    setAnchor(undefined);
                    // Open synchronously; measurement only adjusts placement.
                    setSelectedId(selectionKey(run));
                    if (Platform.OS === 'web') node?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
                }}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            >
                <Text style={styles.label}>
                    {t('rightPanelCapabilityHub.browserProgress.view')}{runs.length > 1 ? ` · ${index + 1}/${runs.length}` : ''}
                </Text>
            </Pressable>)}
        </View>
        {selected ? <BrowserStepsPopover
            key={`${context.scopeKey ?? context.sessionId}:${selectionKey(selected)}`}
            open
            dialogId={`browser-progress-dialog-${selected.id}`}
            sessionId={context.sessionId}
            steps={selected.steps}
            anchor={anchor}
            onClose={() => setSelectedId(null)}
            returnFocusRef={{ current: refs.current.get(selectionKey(selected)) ?? null }}
        /> : null}
    </>;
}

const styles = StyleSheet.create(theme => ({
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, flexShrink: 1 },
    button: { paddingHorizontal: 7, paddingVertical: 3, minHeight: 26, borderRadius: 5, justifyContent: 'center', backgroundColor: theme.colors.surface },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    label: { fontSize: 12, lineHeight: 18, color: theme.colors.text },
}));
