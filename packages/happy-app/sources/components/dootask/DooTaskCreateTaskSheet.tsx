import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator, TextInput, Platform, ScrollView } from 'react-native';
import {
    BottomSheetModal,
    BottomSheetBackdrop,
    BottomSheetScrollView,
    BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { showToast } from '@/components/Toast';
import { Switch } from '@/components/Switch';
import { storage, useDootaskProfile, useDootaskProjects, useDootaskLastSelection } from '@/sync/storage';
import {
    dootaskFetchProjectColumns,
    dootaskFetchProjectMembers,
    dootaskFetchPriorities,
    dootaskCreateTask,
} from '@/sync/dootask/api';
import type {
    DooTaskColumn,
    DooTaskPriority,
    DooTaskProjectMember,
    DooTaskProject,
} from '@/sync/dootask/types';

const SheetTextInput = Platform.OS === 'web' ? TextInput : BottomSheetTextInput;

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
            <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
            <Pressable
                style={[styles.fieldRow, { backgroundColor: theme.colors.groupped.background }]}
                onPress={() => !loading && setExpanded(!expanded)}
            >
                {loading ? (
                    <ActivityIndicator size="small" />
                ) : (
                    <>
                        <Text
                            style={[styles.fieldValue, { color: selectedItem ? theme.colors.text : theme.colors.textSecondary }]}
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

export const DooTaskCreateTaskSheet = React.memo(
    React.forwardRef<BottomSheetModal, {}>((_props, ref) => {
        const { theme } = useUnistyles();
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

        // Data
        const [columns, setColumns] = React.useState<DooTaskColumn[]>([]);
        const [priorities, setPriorities] = React.useState<DooTaskPriority[]>([]);
        const [members, setMembers] = React.useState<DooTaskProjectMember[]>([]);
        const [loadingColumns, setLoadingColumns] = React.useState(false);
        const [loadingPriorities, setLoadingPriorities] = React.useState(false);
        const [loadingMembers, setLoadingMembers] = React.useState(false);
        const [submitting, setSubmitting] = React.useState(false);
        const [error, setError] = React.useState<string | null>(null);

        // Assignee section expanded
        const [assigneeExpanded, setAssigneeExpanded] = React.useState(false);

        // Android picker state
        const [androidPicker, setAndroidPicker] = React.useState<{ field: 'start' | 'end'; mode: 'date' | 'time' } | null>(null);

        // Validation
        const isValid = React.useMemo(() => {
            return (
                !!selectedProjectId &&
                !!selectedColumnId &&
                taskName.trim().length >= 2
            );
        }, [selectedProjectId, selectedColumnId, taskName]);

        // Reset form
        const resetForm = React.useCallback(() => {
            setTaskName('');
            setTaskContent('');
            setSelectedPriority(null);
            setSelectedOwners([]);
            setStartDate(null);
            setEndDate(null);
            setEnableTime(false);
            setColumns([]);
            setPriorities([]);
            setMembers([]);
            setError(null);
            setAssigneeExpanded(false);
            setAndroidPicker(null);
        }, []);

        // Load project-dependent data (columns, members)
        const loadProjectData = React.useCallback(async (projectId: number) => {
            if (!profile) return;
            setLoadingColumns(true);
            setLoadingMembers(true);
            setError(null);

            try {
                const [colRes, memRes] = await Promise.all([
                    dootaskFetchProjectColumns(profile.serverUrl, profile.token, projectId),
                    dootaskFetchProjectMembers(profile.serverUrl, profile.token, projectId),
                ]);

                if (colRes.ret === 1) {
                    const cols: DooTaskColumn[] = (colRes.data || []).map((c: any) => ({
                        id: c.id,
                        name: c.name,
                        sort: c.sort ?? 0,
                    }));
                    setColumns(cols);
                    // Default to lastSelection columnId if available, else first
                    const lastCol = cols.find((c) => c.id === lastSelection.columnId);
                    setSelectedColumnId(lastCol ? lastCol.id : cols[0]?.id ?? null);
                } else {
                    setColumns([]);
                    setSelectedColumnId(null);
                }

                if (memRes.ret === 1) {
                    const projectData = memRes.data;
                    const memberList: DooTaskProjectMember[] = (projectData?.project_user || projectData?.projectUser || []).map((m: any) => ({
                        userid: m.userid,
                        nickname: m.nickname || `User ${m.userid}`,
                        userimg: m.userimg || null,
                        owner: m.owner ?? 0,
                    }));
                    setMembers(memberList);
                } else {
                    setMembers([]);
                }
            } catch {
                setError(t('dootask.createFailed'));
            } finally {
                setLoadingColumns(false);
                setLoadingMembers(false);
            }
        }, [profile, lastSelection.columnId]);

        // Load priorities
        const loadPriorities = React.useCallback(async () => {
            if (!profile) return;
            setLoadingPriorities(true);
            try {
                const res = await dootaskFetchPriorities(profile.serverUrl, profile.token);
                if (res.ret === 1) {
                    const list: DooTaskPriority[] = (res.data || []).map((p: any) => ({
                        priority: p.priority,
                        name: p.name,
                        color: p.color,
                    }));
                    setPriorities(list);
                }
            } catch {
                // Non-critical, silently fail
            } finally {
                setLoadingPriorities(false);
            }
        }, [profile]);

        // On sheet present: initialize
        const handleSheetChange = React.useCallback((index: number) => {
            if (index >= 0) {
                // Sheet opened
                const initialProjectId = lastSelection.projectId ?? projects[0]?.id ?? null;
                setSelectedProjectId(initialProjectId);
                if (initialProjectId) {
                    loadProjectData(initialProjectId);
                }
                loadPriorities();
            }
        }, [lastSelection.projectId, projects, loadProjectData, loadPriorities]);

        // On dismiss: reset form
        const handleDismiss = React.useCallback(() => {
            resetForm();
        }, [resetForm]);

        // Project change
        const handleProjectChange = React.useCallback((projectId: number) => {
            setSelectedProjectId(projectId);
            setSelectedColumnId(null);
            setSelectedOwners([]);
            setColumns([]);
            setMembers([]);
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
                const params: any = {
                    project_id: selectedProjectId,
                    column_id: selectedColumnId,
                    name: taskName.trim(),
                };

                if (taskContent.trim()) {
                    params.content = taskContent.trim();
                }

                if (selectedOwners.length > 0) {
                    params.owner = selectedOwners;
                }

                if (enableTime && startDate && endDate) {
                    params.times = [formatDateForApi(startDate), formatDateForApi(endDate)];
                }

                if (selectedPriority) {
                    params.p_level = selectedPriority.priority;
                    params.p_name = selectedPriority.name;
                    params.p_color = selectedPriority.color;
                }

                const res = await dootaskCreateTask(profile.serverUrl, profile.token, params);

                if (res.ret === 1) {
                    showToast(t('dootask.createSuccess'));
                    storage.getState().setDootaskLastSelection(selectedProjectId, selectedColumnId);
                    storage.getState().fetchDootaskTasks({ refresh: true });
                    (ref as React.RefObject<BottomSheetModal>).current?.dismiss();
                } else {
                    setError(res.msg || t('dootask.createFailed'));
                }
            } catch {
                setError(t('dootask.createFailed'));
            } finally {
                setSubmitting(false);
            }
        }, [profile, selectedProjectId, selectedColumnId, taskName, taskContent, selectedOwners, enableTime, startDate, endDate, selectedPriority, isValid, ref]);

        const renderBackdrop = React.useCallback(
            (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
            [],
        );

        // No profile means can't create
        if (!profile) return null;

        // No projects available
        const noProjects = projects.length === 0;

        return (
            <BottomSheetModal
                ref={ref}
                snapPoints={['85%']}
                enableDynamicSizing={false}
                backdropComponent={renderBackdrop}
                onChange={handleSheetChange}
                onDismiss={handleDismiss}
                keyboardBehavior="interactive"
                keyboardBlurBehavior="restore"
                android_keyboardInputMode="adjustResize"
                backgroundStyle={{ backgroundColor: theme.colors.surface }}
                handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
            >
                <BottomSheetScrollView
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* Title */}
                    <View style={[styles.titleRow, { borderBottomColor: theme.colors.divider }]}>
                        <Text style={[styles.titleText, { color: theme.colors.text }]}>
                            {t('dootask.createTask')}
                        </Text>
                    </View>

                    {noProjects ? (
                        <View style={styles.emptyContainer}>
                            <Ionicons name="folder-open-outline" size={40} color={theme.colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                                {t('dootask.noProjects')}
                            </Text>
                        </View>
                    ) : (
                        <>
                            {/* Project selector */}
                            <InlinePicker
                                label={t('dootask.project') + ' *'}
                                items={projects}
                                selectedId={selectedProjectId}
                                onSelect={handleProjectChange}
                                loading={false}
                                placeholder={t('dootask.selectProject')}
                            />

                            {/* Column selector */}
                            <InlinePicker
                                label={t('dootask.column') + ' *'}
                                items={columns}
                                selectedId={selectedColumnId}
                                onSelect={setSelectedColumnId}
                                loading={loadingColumns}
                                placeholder={t('dootask.selectColumn')}
                            />

                            {/* Task name */}
                            <View>
                                <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>
                                    {t('dootask.taskName') + ' *'}
                                </Text>
                                <SheetTextInput
                                    style={[
                                        styles.textInput,
                                        {
                                            color: theme.colors.text,
                                            backgroundColor: theme.colors.groupped.background,
                                        },
                                        Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any,
                                    ]}
                                    placeholder={t('dootask.taskNamePlaceholder')}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    value={taskName}
                                    onChangeText={setTaskName}
                                    autoCorrect={false}
                                    maxLength={255}
                                />
                                {taskName.length > 0 && taskName.trim().length < 2 && (
                                    <Text style={[styles.validationText, { color: theme.colors.deleteAction }]}>
                                        {t('dootask.nameTooShort')}
                                    </Text>
                                )}
                            </View>

                            {/* Priority selector */}
                            <View>
                                <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>
                                    {t('dootask.priority')}
                                </Text>
                                {loadingPriorities ? (
                                    <ActivityIndicator size="small" style={{ alignSelf: 'flex-start', marginTop: 4 }} />
                                ) : priorities.length > 0 ? (
                                    <View style={styles.priorityRow}>
                                        {/* No priority option */}
                                        <Pressable
                                            style={[
                                                styles.priorityBlock,
                                                {
                                                    backgroundColor: theme.colors.groupped.background,
                                                    borderColor: !selectedPriority ? theme.colors.button.primary.background : 'transparent',
                                                    borderWidth: 2,
                                                },
                                            ]}
                                            onPress={() => setSelectedPriority(null)}
                                        >
                                            <Ionicons name="remove" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                        {priorities.map((p) => {
                                            const isSelected = selectedPriority?.priority === p.priority;
                                            return (
                                                <Pressable
                                                    key={p.priority}
                                                    style={[
                                                        styles.priorityBlock,
                                                        {
                                                            backgroundColor: p.color,
                                                            borderColor: isSelected ? theme.colors.text : 'transparent',
                                                            borderWidth: 2,
                                                            transform: isSelected ? [{ scale: 1.15 }] : [],
                                                        },
                                                    ]}
                                                    onPress={() => setSelectedPriority(p)}
                                                >
                                                    <Text style={styles.priorityLabel} numberOfLines={1}>
                                                        {p.name}
                                                    </Text>
                                                </Pressable>
                                            );
                                        })}
                                    </View>
                                ) : null}
                            </View>

                            {/* Assignee selector */}
                            <View>
                                <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>
                                    {t('dootask.selectOwner')}
                                </Text>
                                {/* Selected members as chips */}
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
                                {loadingMembers ? (
                                    <ActivityIndicator size="small" style={{ alignSelf: 'flex-start', marginTop: 4 }} />
                                ) : members.length > 0 ? (
                                    <>
                                        <Pressable
                                            style={[styles.fieldRow, { backgroundColor: theme.colors.groupped.background }]}
                                            onPress={() => setAssigneeExpanded(!assigneeExpanded)}
                                        >
                                            <Text style={[styles.fieldValue, { color: theme.colors.textSecondary }]}>
                                                {selectedOwners.length > 0
                                                    ? `${selectedOwners.length} ${t('dootask.assignee').toLowerCase()}`
                                                    : t('dootask.selectOwnerPlaceholder')}
                                            </Text>
                                            <Ionicons
                                                name={assigneeExpanded ? 'chevron-up' : 'chevron-down'}
                                                size={16}
                                                color={theme.colors.textSecondary}
                                            />
                                        </Pressable>
                                        {assigneeExpanded && (
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
                                                                {/* Avatar or initials */}
                                                                {member.userimg ? (
                                                                    <Image
                                                                        source={{ uri: member.userimg }}
                                                                        style={{ width: 28, height: 28, borderRadius: 14 }}
                                                                    />
                                                                ) : (
                                                                    <View style={[styles.initialsCircle, { backgroundColor: theme.colors.button.primary.background + '30' }]}>
                                                                        <Text style={[styles.initialsText, { color: theme.colors.button.primary.background }]}>
                                                                            {getInitials(member.nickname)}
                                                                        </Text>
                                                                    </View>
                                                                )}
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
                                    </>
                                ) : null}
                            </View>

                            {/* Planned Time */}
                            <View>
                                <View style={styles.timeLabelRow}>
                                    <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary, marginBottom: 0 }]}>
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
                                            {Platform.OS === 'ios' ? (
                                                <DateTimePicker
                                                    value={startDate}
                                                    mode="datetime"
                                                    display="compact"
                                                    onChange={(_, d) => d && setStartDate(d)}
                                                />
                                            ) : (
                                                <Pressable onPress={() => setAndroidPicker({ field: 'start', mode: 'date' })}>
                                                    <Text style={[styles.timeValue, { color: theme.colors.text }]}>
                                                        {formatDateForDisplay(startDate)}
                                                    </Text>
                                                </Pressable>
                                            )}
                                        </View>

                                        {/* End time */}
                                        <View style={styles.timeRow}>
                                            <Text style={[styles.timeLabel, { color: theme.colors.textSecondary }]}>
                                                {t('dootask.endTime')}
                                            </Text>
                                            {Platform.OS === 'ios' ? (
                                                <DateTimePicker
                                                    value={endDate}
                                                    mode="datetime"
                                                    display="compact"
                                                    minimumDate={startDate}
                                                    onChange={(_, d) => d && setEndDate(d)}
                                                />
                                            ) : (
                                                <Pressable onPress={() => setAndroidPicker({ field: 'end', mode: 'date' })}>
                                                    <Text style={[styles.timeValue, { color: theme.colors.text }]}>
                                                        {formatDateForDisplay(endDate)}
                                                    </Text>
                                                </Pressable>
                                            )}
                                        </View>

                                        {/* Android date/time picker dialogs */}
                                        {Platform.OS === 'android' && androidPicker && (
                                            <DateTimePicker
                                                value={androidPicker.field === 'start' ? startDate : endDate}
                                                mode={androidPicker.mode}
                                                minimumDate={androidPicker.field === 'end' && androidPicker.mode === 'date' ? startDate : undefined}
                                                onChange={(_, d) => {
                                                    if (!d) { setAndroidPicker(null); return; }
                                                    const setter = androidPicker.field === 'start' ? setStartDate : setEndDate;
                                                    if (androidPicker.mode === 'date') {
                                                        const prev = androidPicker.field === 'start' ? startDate : endDate;
                                                        d.setHours(prev!.getHours(), prev!.getMinutes());
                                                        setter(d);
                                                        setAndroidPicker({ field: androidPicker.field, mode: 'time' });
                                                    } else {
                                                        setter(d);
                                                        setAndroidPicker(null);
                                                    }
                                                }}
                                            />
                                        )}
                                    </View>
                                )}
                            </View>

                            {/* Description */}
                            <View>
                                <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>
                                    {t('dootask.taskDescription')}
                                </Text>
                                <SheetTextInput
                                    style={[
                                        styles.textInput,
                                        styles.multilineInput,
                                        {
                                            color: theme.colors.text,
                                            backgroundColor: theme.colors.groupped.background,
                                        },
                                        Platform.OS === 'web' && { outlineStyle: 'none', outline: 'none', outlineWidth: 0, outlineColor: 'transparent' } as any,
                                    ]}
                                    placeholder={t('dootask.taskDescriptionPlaceholder')}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    value={taskContent}
                                    onChangeText={setTaskContent}
                                    multiline
                                    numberOfLines={4}
                                    textAlignVertical="top"
                                />
                            </View>

                            {/* Error */}
                            {error && (
                                <Text style={[styles.errorText, { color: theme.colors.deleteAction }]}>
                                    {error}
                                </Text>
                            )}

                            {/* Submit button */}
                            <Pressable
                                style={[
                                    styles.submitButton,
                                    {
                                        backgroundColor: isValid && !submitting
                                            ? theme.colors.button.primary.background
                                            : theme.colors.button.primary.background + '50',
                                    },
                                ]}
                                onPress={handleSubmit}
                                disabled={!isValid || submitting}
                            >
                                {submitting ? (
                                    <ActivityIndicator size="small" color="#fff" />
                                ) : (
                                    <Text style={styles.submitButtonText}>
                                        {t('dootask.addTask')}
                                    </Text>
                                )}
                            </Pressable>
                        </>
                    )}
                </BottomSheetScrollView>
            </BottomSheetModal>
        );
    }),
);

// --- Styles ---

const styles = StyleSheet.create((_theme) => ({
    scrollContent: {
        paddingHorizontal: 20,
        paddingBottom: 40,
        gap: 16,
    },
    titleRow: {
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
    },
    titleText: {
        ...Typography.default('semiBold'),
        fontSize: 17,
    },
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
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        marginBottom: 6,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 44,
        paddingHorizontal: 12,
        borderRadius: 10,
    },
    fieldValue: {
        ...Typography.default(),
        fontSize: 15,
        flex: 1,
    },
    textInput: {
        ...Typography.default(),
        fontSize: 15,
        borderRadius: 10,
        paddingHorizontal: 12,
        height: 44,
        padding: 0,
    },
    multilineInput: {
        height: 100,
        paddingVertical: 10,
        textAlignVertical: 'top' as const,
    },
    validationText: {
        ...Typography.default(),
        fontSize: 12,
        marginTop: 4,
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
    priorityRow: {
        flexDirection: 'row',
        gap: 8,
        flexWrap: 'wrap',
    },
    priorityBlock: {
        width: 44,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    priorityLabel: {
        color: '#fff',
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
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
    timeLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 6,
    },
    timePickerContainer: {
        gap: 10,
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
    timeValue: {
        ...Typography.default(),
        fontSize: 14,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 13,
        textAlign: 'center',
    },
    submitButton: {
        height: 48,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 8,
    },
    submitButtonText: {
        color: '#fff',
        ...Typography.default('semiBold'),
        fontSize: 16,
    },
}));
