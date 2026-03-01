import * as React from 'react';
import { View, Text, ScrollView, TextInput, Pressable, ActivityIndicator, Platform, KeyboardAvoidingView } from 'react-native';
import { DatePicker } from '@/components/dootask/DatePicker';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { showToast } from '@/components/Toast';
import { Switch } from '@/components/Switch';
import { layout } from '@/components/layout';
import { ItemGroup } from '@/components/ItemGroup';
import { storage, useDootaskProfile, useDootaskProjects, useDootaskLastSelection, useDootaskPriorities, useDootaskColumns } from '@/sync/storage';
import {
    dootaskFetchProjectMembers,
    dootaskCreateTask,
    isTokenExpired,
} from '@/sync/dootask/api';
import type {
    CreateTaskParams,
    DooTaskPriority,
    DooTaskProjectMember,
} from '@/sync/dootask/types';

// --- Helpers ---

function formatDateForDisplay(date: Date): string {
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatDateForApi(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const sec = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${sec}`;
}

function getInitials(name: string): string {
    return name.slice(0, 2).toUpperCase();
}

function resolveAvatarUrl(avatarPath: string | null | undefined, serverUrl: string): string | null {
    if (!avatarPath) return null;
    const base = serverUrl.replace(/\/+$/, '') + '/';
    const resolved = avatarPath.replace(/\{\{RemoteURL\}\}/g, base);
    if (resolved.startsWith('http') || resolved.startsWith('//')) return resolved;
    return base + resolved.replace(/^\/+/, '');
}

// --- Sub-components ---

/**
 * Collapsible inline picker for project or column selection.
 * Shows current value as a row; on press, expands a scrollable list.
 */
const InlinePicker = React.memo(<T extends { id: number; name: string }>({
    label,
    items,
    selectedId,
    onSelect,
    loading,
    placeholder,
}: {
    label: string;
    items: T[];
    selectedId: number | null;
    onSelect: (id: number) => void;
    loading: boolean;
    placeholder: string;
}) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const selectedItem = items.find((i) => i.id === selectedId);

    return (
        <View>
            <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
            <Pressable
                style={[styles.pickerRow, { backgroundColor: theme.colors.surface }]}
                onPress={() => !loading && setExpanded(!expanded)}
            >
                {loading ? (
                    <ActivityIndicator size="small" />
                ) : (
                    <>
                        <Text
                            style={[styles.pickerValue, { color: selectedItem ? theme.colors.text : theme.colors.textSecondary }]}
                            numberOfLines={1}
                        >
                            {selectedItem?.name ?? placeholder}
                        </Text>
                        <Ionicons
                            name={expanded ? 'chevron-up' : 'chevron-down'}
                            size={16}
                            color={theme.colors.textSecondary}
                        />
                    </>
                )}
            </Pressable>
            {expanded && !loading && (
                <View style={[styles.pickerList, { borderColor: theme.colors.divider }]}>
                    <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {items.map((item) => {
                            const isSelected = item.id === selectedId;
                            return (
                                <Pressable
                                    key={item.id}
                                    style={[
                                        styles.pickerOption,
                                        isSelected && { backgroundColor: theme.colors.button.primary.background + '18' },
                                    ]}
                                    onPress={() => {
                                        onSelect(item.id);
                                        setExpanded(false);
                                    }}
                                >
                                    <Text
                                        style={[styles.pickerOptionText, { color: theme.colors.text }]}
                                        numberOfLines={1}
                                    >
                                        {item.name}
                                    </Text>
                                    {isSelected && <Ionicons name="checkmark" size={18} color={theme.colors.button.primary.background} />}
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                </View>
            )}
        </View>
    );
});

// --- Main Component ---

export default React.memo(function AddTaskPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    const profile = useDootaskProfile();
    const projects = useDootaskProjects();
    const lastSelection = useDootaskLastSelection();

    // Form state
    const [selectedProjectId, setSelectedProjectId] = React.useState<number | null>(null);
    const [selectedColumnId, setSelectedColumnId] = React.useState<number | null>(null);
    const [taskName, setTaskName] = React.useState('');
    const [taskContent, setTaskContent] = React.useState('');
    const [selectedPriority, setSelectedPriority] = React.useState<DooTaskPriority | null>(null);
    const [selectedOwners, setSelectedOwners] = React.useState<number[]>([]);
    const [startDate, setStartDate] = React.useState<Date | null>(null);
    const [endDate, setEndDate] = React.useState<Date | null>(null);
    const [enableTime, setEnableTime] = React.useState(false);

    // Data from store (cached)
    const priorities = useDootaskPriorities();
    const columns = useDootaskColumns(selectedProjectId);

    // Data (local)
    const [members, setMembers] = React.useState<DooTaskProjectMember[]>([]);
    const [loadingMembers, setLoadingMembers] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // Assignee section expanded
    const [assigneeExpanded, setAssigneeExpanded] = React.useState(false);

    // Picker state (cross-platform)
    const [activePicker, setActivePicker] = React.useState<'start' | 'end' | null>(null);

    // Validation
    const isValid = React.useMemo(() => {
        return (
            !!selectedProjectId &&
            !!selectedColumnId &&
            taskName.trim().length >= 2
        );
    }, [selectedProjectId, selectedColumnId, taskName]);

    // Apply priority -> time association
    const applyPriorityTime = React.useCallback((p: DooTaskPriority) => {
        if (p.days > 0) {
            const start = new Date();
            start.setHours(9, 0, 0, 0);
            const end = new Date();
            end.setDate(end.getDate() + p.days);
            end.setHours(18, 0, 0, 0);
            setStartDate(start);
            setEndDate(end);
            setEnableTime(true);
        }
    }, []);

    // Load project-dependent data (members + trigger column cache refresh)
    const loadProjectData = React.useCallback(async (projectId: number) => {
        if (!profile) return;
        setLoadingMembers(true);
        setError(null);

        // Trigger column cache refresh in background
        storage.getState().fetchDootaskColumns(projectId);

        try {
            const memRes = await dootaskFetchProjectMembers(profile.serverUrl, profile.token, projectId);

            if (memRes.ret === 1) {
                const rawMembers = memRes.data?.data || memRes.data || [];
                const memberList: DooTaskProjectMember[] = (Array.isArray(rawMembers) ? rawMembers : []).map((m: any) => ({
                    userid: m.userid,
                    nickname: m.nickname || `User ${m.userid}`,
                    userimg: m.userimg || null,
                    owner: 0,
                }));
                setMembers(memberList);
            } else {
                setMembers([]);
            }
        } catch {
            setError(t('dootask.createFailed'));
        } finally {
            setLoadingMembers(false);
        }
    }, [profile]);

    // Initialize on mount
    React.useEffect(() => {
        const initialProjectId = lastSelection.projectId ?? projects[0]?.id ?? null;
        setSelectedProjectId(initialProjectId);
        if (initialProjectId) {
            loadProjectData(initialProjectId);
        }
        // Trigger background refresh of cached data
        storage.getState().fetchDootaskPriorities();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-select default priority when priorities load from cache/API
    const priorityInitRef = React.useRef(false);
    React.useEffect(() => {
        if (priorities.length > 0 && !priorityInitRef.current) {
            priorityInitRef.current = true;
            const defaultP = priorities.find((p) => p.is_default === 1) || priorities[0];
            if (defaultP) {
                setSelectedPriority(defaultP);
                applyPriorityTime(defaultP);
            }
        }
    }, [priorities, applyPriorityTime]);

    // Auto-select column when columns load from cache/API
    const columnInitRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (columns.length > 0 && selectedProjectId && columnInitRef.current !== selectedProjectId) {
            columnInitRef.current = selectedProjectId;
            const lastCol = columns.find((c) => c.id === lastSelection.columnId);
            setSelectedColumnId(lastCol ? lastCol.id : columns[0]?.id ?? null);
        }
    }, [columns, selectedProjectId, lastSelection.columnId]);

    // Project change
    const handleProjectChange = React.useCallback((projectId: number) => {
        setSelectedProjectId(projectId);
        setSelectedColumnId(null);
        setSelectedOwners([]);
        setMembers([]);
        columnInitRef.current = null; // Reset so columns effect re-selects
        loadProjectData(projectId);
    }, [loadProjectData]);

    // Toggle assignee
    const toggleOwner = React.useCallback((userId: number) => {
        setSelectedOwners((prev: number[]) => {
            if (prev.includes(userId)) {
                return prev.filter((id: number) => id !== userId);
            }
            if (prev.length >= 10) return prev;
            return [...prev, userId];
        });
    }, []);

    // Submit
    const handleSubmit = React.useCallback(async () => {
        if (!profile || !selectedProjectId || !selectedColumnId || !isValid) return;

        setSubmitting(true);
        setError(null);

        try {
            const params: CreateTaskParams = {
                project_id: selectedProjectId,
                column_id: selectedColumnId,
                name: taskName.trim(),
                ...(taskContent.trim() ? { content: taskContent.trim() } : {}),
                ...(selectedOwners.length > 0 ? { owner: selectedOwners } : {}),
                ...(enableTime && startDate && endDate ? { times: [formatDateForApi(startDate), formatDateForApi(endDate)] as [string, string] } : {}),
                ...(selectedPriority ? { p_level: selectedPriority.priority, p_name: selectedPriority.name, p_color: selectedPriority.color } : {}),
            };

            const res = await dootaskCreateTask(profile.serverUrl, profile.token, params);

            if (isTokenExpired(res)) {
                setError(t('dootask.tokenExpired'));
            } else if (res.ret === 1) {
                showToast(t('dootask.createSuccess'));
                storage.getState().setDootaskLastSelection(selectedProjectId, selectedColumnId);
                storage.getState().fetchDootaskTasks({ refresh: true });
                router.back();
            } else {
                setError(res.msg || t('dootask.createFailed'));
            }
        } catch {
            setError(t('dootask.createFailed'));
        } finally {
            setSubmitting(false);
        }
    }, [profile, selectedProjectId, selectedColumnId, taskName, taskContent, selectedOwners, enableTime, startDate, endDate, selectedPriority, isValid, router]);

    if (!profile) return null;

    const noProjects = projects.length === 0;

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + headerHeight : 0}
        >
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={[styles.scrollContent, { paddingBottom: safeArea.bottom + 24 }]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            >
                {noProjects ? (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="folder-open-outline" size={40} color={theme.colors.textSecondary} />
                        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                            {t('dootask.noProjects')}
                        </Text>
                    </View>
                ) : (
                    <>
                        {/* Project & Column */}
                        <View style={styles.rowContainer}>
                            <View style={styles.halfColumn}>
                                <InlinePicker
                                    label={t('dootask.project') + ' *'}
                                    items={projects}
                                    selectedId={selectedProjectId}
                                    onSelect={handleProjectChange}
                                    loading={false}
                                    placeholder={t('dootask.selectProject')}
                                />
                            </View>
                            <View style={styles.halfColumn}>
                                <InlinePicker
                                    label={t('dootask.column') + ' *'}
                                    items={columns}
                                    selectedId={selectedColumnId}
                                    onSelect={setSelectedColumnId}
                                    loading={columns.length === 0 && !!selectedProjectId}
                                    placeholder={t('dootask.selectColumn')}
                                />
                            </View>
                        </View>

                        {/* Task Name */}
                        <ItemGroup title={t('dootask.taskName') + ' *'}>
                            <View style={styles.inputWrapper}>
                                <TextInput
                                    style={styles.input}
                                    value={taskName}
                                    onChangeText={setTaskName}
                                    placeholder={t('dootask.taskNamePlaceholder')}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    autoCorrect={false}
                                    maxLength={255}
                                />
                            </View>
                        </ItemGroup>
                        {taskName.length > 0 && taskName.trim().length < 2 && (
                            <Text style={[styles.validationText, { color: theme.colors.deleteAction }]}>
                                {t('dootask.nameTooShort')}
                            </Text>
                        )}

                        {/* Priority */}
                        <View style={styles.sectionContainer}>
                            <Text style={[styles.sectionTitle, { color: theme.colors.groupped.sectionTitle }]}>
                                {t('dootask.priority').toUpperCase()}
                            </Text>
                            {priorities.length > 0 ? (
                                <View style={styles.priorityRow}>
                                    {priorities.map((p) => {
                                        const isSelected = selectedPriority?.priority === p.priority;
                                        return (
                                            <Pressable
                                                key={p.priority}
                                                style={[
                                                    styles.priorityBlock,
                                                    {
                                                        backgroundColor: p.color,
                                                        borderColor: isSelected ? theme.colors.text : p.color,
                                                        borderWidth: 2,
                                                    },
                                                ]}
                                                onPress={() => {
                                                    setSelectedPriority(p);
                                                    applyPriorityTime(p);
                                                }}
                                            >
                                                <Text style={styles.priorityLabel} numberOfLines={1}>
                                                    {p.name}
                                                </Text>
                                                {p.days > 0 && (
                                                    <Text style={styles.priorityDays}>{p.days}d</Text>
                                                )}
                                            </Pressable>
                                        );
                                    })}
                                </View>
                            ) : null}
                        </View>

                        {/* Assignee */}
                        <View style={styles.sectionContainer}>
                            <Text style={[styles.sectionTitle, { color: theme.colors.groupped.sectionTitle }]}>
                                {t('dootask.selectOwner').toUpperCase()}
                            </Text>
                            {selectedOwners.length > 0 && (
                                <View style={styles.chipsRow}>
                                    {selectedOwners.map((uid) => {
                                        const member = members.find((m) => m.userid === uid);
                                        if (!member) return null;
                                        return (
                                            <View key={uid} style={[styles.chip, { backgroundColor: theme.colors.button.primary.background + '20' }]}>
                                                <Text style={[styles.chipText, { color: theme.colors.button.primary.background }]} numberOfLines={1}>
                                                    {member.nickname}
                                                </Text>
                                                <Pressable onPress={() => toggleOwner(uid)} hitSlop={4}>
                                                    <Ionicons name="close-circle" size={14} color={theme.colors.button.primary.background} />
                                                </Pressable>
                                            </View>
                                        );
                                    })}
                                </View>
                            )}
                            <Pressable
                                style={[styles.assigneePickerRow, { backgroundColor: theme.colors.surface }]}
                                onPress={() => !loadingMembers && setAssigneeExpanded(!assigneeExpanded)}
                            >
                                {loadingMembers ? (
                                    <ActivityIndicator size="small" />
                                ) : (
                                    <>
                                        <Text style={[styles.pickerValue, { color: theme.colors.textSecondary }]}>
                                            {selectedOwners.length > 0
                                                ? `${selectedOwners.length} ${t('dootask.assignee').toLowerCase()}`
                                                : t('dootask.selectOwnerPlaceholder')}
                                        </Text>
                                        <Ionicons
                                            name={assigneeExpanded ? 'chevron-up' : 'chevron-down'}
                                            size={16}
                                            color={theme.colors.textSecondary}
                                        />
                                    </>
                                )}
                            </Pressable>
                            {assigneeExpanded && !loadingMembers && members.length > 0 && (
                                <View style={[styles.pickerList, { borderColor: theme.colors.divider }]}>
                                    <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                                        {members.map((member) => {
                                            const isSelected = selectedOwners.includes(member.userid);
                                            const isDisabled = !isSelected && selectedOwners.length >= 10;
                                            return (
                                                <Pressable
                                                    key={member.userid}
                                                    style={[
                                                        styles.memberRow,
                                                        isDisabled && { opacity: 0.4 },
                                                    ]}
                                                    onPress={() => !isDisabled && toggleOwner(member.userid)}
                                                >
                                                    {(() => {
                                                        const avatarUrl = profile ? resolveAvatarUrl(member.userimg, profile.serverUrl) : null;
                                                        return avatarUrl ? (
                                                            <Image
                                                                source={{ uri: avatarUrl }}
                                                                style={{ width: 28, height: 28, borderRadius: 14 }}
                                                            />
                                                        ) : (
                                                            <View style={[styles.initialsCircle, { backgroundColor: theme.colors.button.primary.background + '30' }]}>
                                                                <Text style={[styles.initialsText, { color: theme.colors.button.primary.background }]}>
                                                                    {getInitials(member.nickname)}
                                                                </Text>
                                                            </View>
                                                        );
                                                    })()}
                                                    <Text style={[styles.memberName, { color: theme.colors.text }]} numberOfLines={1}>
                                                        {member.nickname}
                                                    </Text>
                                                    <Ionicons
                                                        name={isSelected ? 'checkbox' : 'square-outline'}
                                                        size={20}
                                                        color={isSelected ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                                    />
                                                </Pressable>
                                            );
                                        })}
                                    </ScrollView>
                                </View>
                            )}
                        </View>

                        {/* Planned Time */}
                        <ItemGroup title={t('dootask.plannedTime')} containerStyle={[
                                styles.timeItemGroup,
                                Platform.OS === 'web' && { 
                                    paddingTop: 4,
                                    paddingBottom: 0
                                } as any
                            ]}>
                            <View style={styles.timeSwitchRow}>
                                <Text style={{ ...Typography.default(), fontSize: 15, color: theme.colors.text }}>
                                    {t('dootask.plannedTime')}
                                </Text>
                                <Switch
                                    value={enableTime}
                                    onValueChange={(val) => {
                                        setEnableTime(val);
                                        if (val && !startDate) {
                                            setStartDate(new Date());
                                            const end = new Date();
                                            end.setDate(end.getDate() + 7);
                                            setEndDate(end);
                                        }
                                    }}
                                />
                            </View>
                            {enableTime && startDate && endDate && (
                                <View style={styles.timePickerContainer}>
                                    {/* Start time */}
                                    <View style={styles.timeRow}>
                                        <Text style={[styles.timeLabel, { color: theme.colors.textSecondary }]}>
                                            {t('dootask.startTime')}
                                        </Text>
                                        <Pressable style={styles.timeValueBtn} onPress={() => setActivePicker(activePicker === 'start' ? null : 'start')}>
                                            <Text style={[styles.timeValue, { color: theme.colors.text }]}>
                                                {formatDateForDisplay(startDate)}
                                            </Text>
                                        </Pressable>
                                    </View>

                                    {/* End time */}
                                    <View style={styles.timeRow}>
                                        <Text style={[styles.timeLabel, { color: theme.colors.textSecondary }]}>
                                            {t('dootask.endTime')}
                                        </Text>
                                        <Pressable style={styles.timeValueBtn} onPress={() => setActivePicker(activePicker === 'end' ? null : 'end')}>
                                            <Text style={[styles.timeValue, { color: theme.colors.text }]}>
                                                {formatDateForDisplay(endDate)}
                                            </Text>
                                        </Pressable>
                                    </View>

                                    {/* Inline date/time picker */}
                                    {activePicker && (
                                        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider, paddingTop: 8, marginTop: 8 }}>
                                            <DatePicker
                                                key={activePicker}
                                                date={activePicker === 'start' ? startDate : endDate}
                                                minDate={activePicker === 'end' ? startDate : undefined}
                                                onChange={(d) => {
                                                    if (activePicker === 'start') {
                                                        setStartDate(d);
                                                        if (endDate && d >= endDate) {
                                                            setEndDate(new Date(d.getTime() + 3600000));
                                                        }
                                                    } else {
                                                        setEndDate(d);
                                                    }
                                                }}
                                            />
                                            <Pressable
                                                style={[styles.iosPickerDoneBtn, { backgroundColor: theme.colors.button.primary.background }]}
                                                onPress={() => setActivePicker(null)}
                                            >
                                                <Text style={[styles.iosPickerDoneBtnText, { color: theme.colors.button.primary.tint }]}>{t('common.ok')}</Text>
                                            </Pressable>
                                        </View>
                                    )}
                                </View>
                            )}
                        </ItemGroup>

                        {/* Description */}
                        <ItemGroup title={t('dootask.taskDescription')}>
                            <View style={styles.inputWrapper}>
                                <TextInput
                                    style={[styles.input, styles.multilineInput]}
                                    value={taskContent}
                                    onChangeText={setTaskContent}
                                    placeholder={t('dootask.taskDescriptionPlaceholder')}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    multiline
                                    numberOfLines={4}
                                    textAlignVertical="top"
                                />
                            </View>
                        </ItemGroup>

                        {/* Error */}
                        {error && (
                            <Text style={[styles.errorText, { color: theme.colors.deleteAction }]}>
                                {error}
                            </Text>
                        )}

                        {/* Submit */}
                        <Pressable
                            style={[styles.submitButton, (!isValid || submitting) && styles.submitButtonDisabled]}
                            onPress={handleSubmit}
                            disabled={!isValid || submitting}
                        >
                            {submitting ? (
                                <ActivityIndicator color={theme.colors.button.primary.tint} />
                            ) : (
                                <Text style={styles.submitButtonText}>{t('dootask.addTask')}</Text>
                            )}
                        </Pressable>
                    </>
                )}
            </ScrollView>
        </KeyboardAvoidingView>
    );
});

// --- Styles ---

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    inputWrapper: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
    },
    input: {
        borderRadius: 16,
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default(),
    },
    multilineInput: {
        height: 100,
        paddingVertical: 10,
        textAlignVertical: 'top' as const,
    },
    submitButton: {
        backgroundColor: theme.colors.button.primary.background,
        marginHorizontal: 16,
        marginTop: 24,
        paddingVertical: 14,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        height: 50,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 17,
        ...Typography.default('semiBold'),
    },
    // Project/Column inline picker styles
    rowContainer: {
        flexDirection: 'row',
        gap: 12,
        paddingHorizontal: 16,
        paddingTop: 35,
    },
    halfColumn: {
        flex: 1,
    },
    sectionLabel: {
        ...Typography.default('regular'),
        fontSize: 13,
        marginBottom: 6,
        paddingLeft: 16,
    },
    pickerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 44,
        paddingHorizontal: 12,
        borderRadius: 10,
    },
    pickerValue: {
        ...Typography.default(),
        fontSize: 15,
        flex: 1,
    },
    pickerList: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        marginTop: 4,
        overflow: 'hidden',
    },
    pickerOption: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 44,
        paddingHorizontal: 12,
    },
    pickerOptionText: {
        ...Typography.default(),
        fontSize: 15,
        flex: 1,
    },
    // Standalone section (no card wrapper)
    sectionContainer: {
        paddingHorizontal: 16,
        paddingTop: 35,
    },
    sectionTitle: {
        ...Typography.default('regular'),
        fontSize: 13,
        marginBottom: 6,
        paddingHorizontal: 16,
    },
    // Priority styles
    priorityRow: {
        flexDirection: 'row',
        gap: 8,
        flexWrap: 'wrap',
    },
    priorityBlock: {
        flex: 1,
        minWidth: 60,
        height: 40,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    priorityLabel: {
        color: '#fff',
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    priorityDays: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 10,
        ...Typography.default(),
    },
    // Assignee styles
    chipsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        marginBottom: 8,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 14,
        gap: 4,
    },
    chipText: {
        ...Typography.default(),
        fontSize: 13,
        maxWidth: 120,
    },
    assigneePickerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 44,
        paddingHorizontal: 12,
        borderRadius: 10,
    },
    memberRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        height: 44,
    },
    initialsCircle: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    initialsText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
    },
    memberName: {
        ...Typography.default(),
        fontSize: 14,
        flex: 1,
    },
    timeItemGroup: {
        paddingTop: 8,
        paddingBottom: 8
    },
    // Time picker styles
    timeSwitchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        minHeight: 44,
        paddingVertical: 8,
    },
    timePickerContainer: {
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    timeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 40,
    },
    timeLabel: {
        ...Typography.default(),
        fontSize: 14,
    },
    timeValueBtn: {
        paddingVertical: 8,
        paddingLeft: 12,
    },
    timeValue: {
        ...Typography.default(),
        fontSize: 14,
    },
    // Validation & Error
    validationText: {
        ...Typography.default(),
        fontSize: 12,
        marginTop: 6,
        paddingHorizontal: 32,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 13,
        textAlign: 'center',
        marginHorizontal: 16,
    },
    // iOS picker done button
    iosPickerDoneBtn: {
        alignSelf: 'center',
        paddingHorizontal: 32,
        paddingVertical: 8,
        borderRadius: 8,
        marginTop: 4,
        marginBottom: 8,
    },
    iosPickerDoneBtnText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
    },
    // Empty state
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 60,
        gap: 12,
    },
    emptyText: {
        ...Typography.default(),
        fontSize: 14,
        textAlign: 'center',
    },
}));
