import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { t } from '@/text';
import type { SessionRowData } from '@/sync/storage';
import { StatusDot } from './StatusDot';
import { SessionActionsPopover, type SessionActionsAnchor } from './SessionActionsPopover';

function anchorFromEvent(event: any): SessionActionsAnchor {
    const target = event?.currentTarget ?? event?.nativeEvent?.target;
    const rect = target?.getBoundingClientRect?.();
    if (rect) {
        return {
            type: 'rect',
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
        };
    }
    return {
        type: 'point',
        x: event?.nativeEvent?.clientX ?? event?.nativeEvent?.pageX ?? 0,
        y: event?.nativeEvent?.clientY ?? event?.nativeEvent?.pageY ?? 0,
    };
}

export function prepareNewSessionForProject(machineId: string, path: string): void {
    const draft = useNewSessionDraft.getState();
    draft.setMachineId(machineId);
    draft.setPath(path);
}

export const ProjectSectionHeader = React.memo(({
    activity,
    current,
    displayPath,
    expanded,
    machineId,
    onCreateSession,
    onToggle,
    path,
    session,
    testID,
}: {
    activity: { color: string; isPulsing: boolean } | null;
    current: boolean;
    displayPath: string;
    expanded: boolean;
    machineId: string;
    onCreateSession: () => void;
    onToggle: () => void;
    path: string;
    session: SessionRowData;
    testID: string;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [menuAnchor, setMenuAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const repoFolderName = (path || session.path || displayPath)
        .split(/[/\\]/)
        .filter(Boolean)
        .pop() || displayPath;
    const showActions = Platform.OS === 'web' && (hovered || !!menuAnchor);

    const openContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setMenuAnchor(anchorFromEvent(event));
    }, []);

    const createSession = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        prepareNewSessionForProject(machineId, path);
        onCreateSession();
    }, [machineId, onCreateSession, path]);

    const hoverProps = Platform.OS === 'web' ? {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
    } as any : {};
    const contextMenuProps = Platform.OS === 'web' ? {
        onContextMenu: openContextMenu,
    } as any : {};

    return (
        <View
            style={[styles.sectionHeader, (hovered || !!menuAnchor) && styles.sectionHeaderHovered]}
            testID={`${testID}-container`}
            {...hoverProps}
        >
            <Pressable
                accessibilityLabel={repoFolderName}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
                onPress={onToggle}
                style={({ pressed }) => [
                    styles.sectionHeaderMain,
                    showActions && styles.sectionHeaderMainWithActions,
                    pressed && styles.sectionHeaderPressed,
                ]}
                testID={testID}
                {...contextMenuProps}
            >
                <View style={styles.sectionFolder}>
                    <Feather
                        name="folder"
                        size={18}
                        color={current ? theme.colors.text : theme.colors.textSecondary}
                    />
                </View>
                <Text
                    style={[styles.sectionHeaderPath, expanded && styles.sectionHeaderPathExpanded]}
                    numberOfLines={1}
                >
                    {repoFolderName}
                </Text>
                {activity && !showActions ? (
                    <View style={styles.projectActivity}>
                        <StatusDot color={activity.color} isPulsing={activity.isPulsing} />
                    </View>
                ) : null}
            </Pressable>

            {showActions ? (
                <View style={styles.actionCluster} testID={`${testID}-actions`}>
                    <ProjectHeaderAction
                        icon="edit-3"
                        label={t('sidebar.newSession')}
                        onPress={createSession}
                        testID={`${testID}-new-session-action`}
                    />
                </View>
            ) : null}

            <SessionActionsPopover
                anchor={menuAnchor}
                onClose={() => setMenuAnchor(null)}
                sessionId={session.id}
                visible={!!menuAnchor}
            />
        </View>
    );
});

const ProjectHeaderAction = React.memo(({
    icon,
    label,
    onPress,
    testID,
}: {
    icon: React.ComponentProps<typeof Feather>['name'];
    label: string;
    onPress: (event: any) => void;
    testID: string;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const webTitle = Platform.OS === 'web' ? { title: label } as any : {};

    return (
        <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            hitSlop={4}
            onPress={onPress}
            style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
            testID={testID}
            {...webTitle}
        >
            <Feather
                color={theme.colors.textSecondary}
                dataSet={{ iconName: icon }}
                name={icon}
                size={16}
            />
        </Pressable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    sectionHeader: {
        alignItems: 'center',
        borderRadius: 10,
        flexDirection: 'row',
        marginHorizontal: 8,
        minHeight: 38,
        minWidth: 0,
    },
    sectionHeaderHovered: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sectionHeaderPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    sectionHeaderMain: {
        alignItems: 'center',
        alignSelf: 'stretch',
        flex: 1,
        flexDirection: 'row',
        minWidth: 0,
        paddingHorizontal: 10,
    },
    sectionHeaderMainWithActions: {
        paddingRight: 2,
    },
    sectionFolder: {
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
        width: 18,
    },
    sectionHeaderPath: {
        ...Typography.default('regular'),
        color: theme.colors.text,
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
        minWidth: 0,
    },
    sectionHeaderPathExpanded: {
        ...Typography.default('semiBold'),
    },
    projectActivity: {
        alignItems: 'center',
        height: 18,
        justifyContent: 'center',
        marginLeft: 8,
        width: 18,
    },
    actionCluster: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 2,
        paddingRight: 6,
    },
    actionButton: {
        alignItems: 'center',
        borderRadius: 7,
        height: 28,
        justifyContent: 'center',
        width: 28,
    },
    actionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
}));
