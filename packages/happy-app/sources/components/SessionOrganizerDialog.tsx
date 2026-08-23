import * as React from 'react';
import { Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { mq, StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import {
    createSidebarOrganizationId,
    normalizeSidebarTagName,
    SIDEBAR_LIST_COLORS,
    SIDEBAR_SESSION_TAG_MAX_COUNT,
    SIDEBAR_TAG_MAX_COUNT,
    type SidebarListColor,
    type SidebarOrganization,
    type SidebarSessionOrganization,
    type SidebarTag,
} from '@/sync/sidebarOrganization';
import { t } from '@/text';
import { DesktopDialogFrame } from './DesktopDialogFrame';

const TAG_RESULTS_ID = 'session-organizer-tag-results';

function getTagColors(colors: any): Record<SidebarListColor, string> {
    return {
        blue: colors.textLink,
        green: colors.success,
        purple: colors.particle.accent,
        orange: colors.accent,
        pink: colors.deleteAction,
    };
}

export function SessionOrganizerDialog({
    assignment,
    autoFocusTags = false,
    onClose,
    onSave,
    organization,
    sessionName,
    visible,
}: {
    assignment: SidebarSessionOrganization;
    autoFocusTags?: boolean;
    onClose: () => void;
    onSave: (assignment: SidebarSessionOrganization, createdTags: SidebarTag[]) => void;
    organization: SidebarOrganization;
    sessionName: string;
    visible: boolean;
}) {
    const { theme } = useUnistyles();
    const tagColors = getTagColors(theme.colors);
    const inputRef = React.useRef<TextInput>(null);
    const [draft, setDraft] = React.useState(assignment);
    const [createdTags, setCreatedTags] = React.useState<SidebarTag[]>([]);
    const [query, setQuery] = React.useState('');
    const [activeOption, setActiveOption] = React.useState(0);
    const [inputFocused, setInputFocused] = React.useState(false);

    React.useEffect(() => {
        if (!visible) return;
        setDraft(assignment);
        setCreatedTags([]);
        setQuery('');
        setActiveOption(0);
        setInputFocused(false);
    }, [assignment, visible]);

    React.useEffect(() => {
        if (!visible || !autoFocusTags) return;
        const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
        return () => clearTimeout(focusTimer);
    }, [autoFocusTags, visible]);

    const allTags = React.useMemo(() => [...organization.tags, ...createdTags], [createdTags, organization.tags]);
    const queryActive = query.startsWith('#');
    const normalizedQuery = normalizeSidebarTagName(query);
    const foldedQuery = normalizedQuery.toLocaleLowerCase();
    const matchingTags = React.useMemo(() => queryActive
        ? allTags.filter((tag) => tag.name.toLocaleLowerCase().includes(foldedQuery))
        : [], [allTags, foldedQuery, queryActive]);
    const exactMatch = allTags.find((tag) => tag.name.toLocaleLowerCase() === foldedQuery);
    const canCreate = queryActive
        && normalizedQuery.length > 0
        && !exactMatch
        && draft.tagIds.length < SIDEBAR_SESSION_TAG_MAX_COUNT
        && allTags.length < SIDEBAR_TAG_MAX_COUNT;
    const optionCount = matchingTags.length + (canCreate ? 1 : 0);

    React.useEffect(() => {
        setActiveOption((current) => Math.max(0, Math.min(current, Math.max(0, optionCount - 1))));
    }, [optionCount]);

    const toggleTag = React.useCallback((tagId: string) => {
        setDraft((current) => {
            if (current.tagIds.includes(tagId)) {
                return { ...current, tagIds: current.tagIds.filter((id) => id !== tagId) };
            }
            if (current.tagIds.length >= SIDEBAR_SESSION_TAG_MAX_COUNT) return current;
            return { ...current, tagIds: [...current.tagIds, tagId] };
        });
    }, []);

    const chooseTag = React.useCallback((tagId: string) => {
        if (!draft.tagIds.includes(tagId) && draft.tagIds.length >= SIDEBAR_SESSION_TAG_MAX_COUNT) return;
        toggleTag(tagId);
        setQuery('');
        setActiveOption(0);
        inputRef.current?.focus();
    }, [draft.tagIds, toggleTag]);

    const createTag = React.useCallback(() => {
        if (!canCreate) {
            if (exactMatch) chooseTag(exactMatch.id);
            return;
        }
        const tag: SidebarTag = {
            id: createSidebarOrganizationId('tag'),
            name: normalizedQuery,
            color: SIDEBAR_LIST_COLORS[allTags.length % SIDEBAR_LIST_COLORS.length],
            createdAt: Date.now(),
        };
        setCreatedTags((current) => [...current, tag]);
        setDraft((current) => current.tagIds.length >= SIDEBAR_SESSION_TAG_MAX_COUNT
            ? current
            : { ...current, tagIds: [...current.tagIds, tag.id] });
        setQuery('');
        setActiveOption(0);
        inputRef.current?.focus();
    }, [allTags.length, canCreate, chooseTag, exactMatch, normalizedQuery]);

    const activateOption = React.useCallback(() => {
        const tag = matchingTags[activeOption];
        if (tag) {
            chooseTag(tag.id);
        } else if (canCreate && activeOption === matchingTags.length) {
            createTag();
        }
    }, [activeOption, canCreate, chooseTag, createTag, matchingTags]);

    const selectedTags = allTags.filter((tag) => draft.tagIds.includes(tag.id));

    return (
        <DesktopDialogFrame onClose={onClose} title={t('sidebarLists.organizeSession')} visible={visible}>
            <ScrollView contentContainerStyle={styles.dialogBody} keyboardShouldPersistTaps="handled">
                <View style={styles.field}>
                    <Text numberOfLines={1} style={styles.fieldLabel}>{sessionName}</Text>
                </View>
                <View accessibilityLabel={t('sidebarLists.belongsToList')} accessibilityRole="radiogroup" style={styles.field}>
                    <Text style={styles.fieldLabel}>{t('sidebarLists.belongsToList')}</Text>
                    <AssignmentChoice
                        label={t('sidebarLists.unassigned')}
                        onPress={() => setDraft((current) => ({ ...current, listId: null }))}
                        selected={draft.listId === null}
                    />
                    {organization.lists.map((list) => (
                        <AssignmentChoice
                            key={list.id}
                            label={list.name}
                            onPress={() => setDraft((current) => ({ ...current, listId: list.id }))}
                            selected={draft.listId === list.id}
                        />
                    ))}
                </View>
                <View style={styles.field}>
                    <Text style={styles.fieldLabel}>{t('sidebarLists.tagsMultiSelect')}</Text>
                    {selectedTags.length > 0 ? (
                        <View accessibilityLabel={t('sidebarLists.selectedTags')} style={styles.selectedTags}>
                            {selectedTags.map((tag) => (
                                <Pressable
                                    accessibilityLabel={`${t('common.delete')} #${tag.name}`}
                                    accessibilityRole="button"
                                    key={tag.id}
                                    onPress={() => toggleTag(tag.id)}
                                    style={({ pressed }) => [styles.selectedTag, pressed && styles.selectedTagPressed]}
                                    testID={`organize-selected-tag-${tag.id}`}
                                >
                                    <View style={[styles.tagDot, { backgroundColor: tagColors[tag.color] }]} />
                                    <Text numberOfLines={1} style={styles.selectedTagText}>#{tag.name}</Text>
                                    <Feather color={theme.colors.textSecondary} name="x" size={13} />
                                </Pressable>
                            ))}
                        </View>
                    ) : null}
                    <TextInput
                        accessibilityLabel={t('sidebarLists.tagInputPlaceholder')}
                        aria-activedescendant={queryActive && optionCount > 0 ? `${TAG_RESULTS_ID}-${activeOption}` : undefined}
                        aria-controls={TAG_RESULTS_ID}
                        aria-expanded={queryActive}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus={autoFocusTags}
                        blurOnSubmit={false}
                        onChangeText={(value) => { setQuery(value); setActiveOption(0); }}
                        onBlur={() => setInputFocused(false)}
                        onFocus={() => setInputFocused(true)}
                        onKeyPress={(event) => {
                            if (!queryActive) return;
                            if (event.nativeEvent.key === 'ArrowDown') {
                                if (Platform.OS === 'web') event.preventDefault();
                                setActiveOption((current) => optionCount > 0 ? (current + 1) % optionCount : 0);
                            } else if (event.nativeEvent.key === 'ArrowUp') {
                                if (Platform.OS === 'web') event.preventDefault();
                                setActiveOption((current) => optionCount > 0 ? (current - 1 + optionCount) % optionCount : 0);
                            } else if (event.nativeEvent.key === 'Escape') {
                                if (Platform.OS === 'web') event.preventDefault();
                                setQuery('');
                            }
                        }}
                        onSubmitEditing={activateOption}
                        placeholder={t('sidebarLists.tagInputPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        ref={inputRef}
                        returnKeyType="done"
                        role="combobox"
                        style={[styles.tagInput, inputFocused && styles.tagInputFocused]}
                        testID="organize-tag-input"
                        value={query}
                    />
                    {queryActive ? (
                        <View nativeID={TAG_RESULTS_ID} role={'listbox' as never} style={styles.tagResults} testID="organize-tag-results">
                            {matchingTags.map((tag, index) => {
                                const selected = draft.tagIds.includes(tag.id);
                                const disabled = !selected && draft.tagIds.length >= SIDEBAR_SESSION_TAG_MAX_COUNT;
                                const active = activeOption === index;
                                return (
                                    <Pressable
                                        role="option"
                                        accessibilityState={{ disabled, selected }}
                                        aria-selected={selected}
                                        disabled={disabled}
                                        key={tag.id}
                                        nativeID={`${TAG_RESULTS_ID}-${index}`}
                                        onPress={() => chooseTag(tag.id)}
                                        style={({ pressed }) => [styles.tagResult, (active || pressed) && styles.tagResultActive, disabled && styles.tagResultDisabled]}
                                        testID={`organize-tag-result-${tag.id}`}
                                    >
                                        <View style={[styles.tagDot, { backgroundColor: tagColors[tag.color] }]} />
                                        <Text style={styles.tagResultText}>#{tag.name}</Text>
                                        {selected ? <Feather color={theme.colors.accent} name="check" size={15} /> : null}
                                    </Pressable>
                                );
                            })}
                            {canCreate ? (
                                <Pressable
                                    role="option"
                                    nativeID={`${TAG_RESULTS_ID}-${matchingTags.length}`}
                                    onPress={createTag}
                                    style={({ pressed }) => [styles.tagResult, (activeOption === matchingTags.length || pressed) && styles.tagResultActive]}
                                    testID="organize-create-tag"
                                >
                                    <Feather color={theme.colors.textSecondary} name="plus" size={15} />
                                    <Text style={styles.tagResultText}>{t('sidebarLists.createTagNamed', { name: `#${normalizedQuery}` })}</Text>
                                </Pressable>
                            ) : null}
                            {matchingTags.length === 0 && !canCreate ? (
                                <Text style={styles.empty}>{allTags.length >= SIDEBAR_TAG_MAX_COUNT || draft.tagIds.length >= SIDEBAR_SESSION_TAG_MAX_COUNT ? t('sidebarLists.tagLimitReached') : t('sidebarLists.noTags')}</Text>
                            ) : null}
                        </View>
                    ) : (
                        <View>
                            {allTags.map((tag) => (
                                <TagChoice
                                    color={tagColors[tag.color]}
                                    disabled={!draft.tagIds.includes(tag.id) && draft.tagIds.length >= SIDEBAR_SESSION_TAG_MAX_COUNT}
                                    key={tag.id}
                                    label={tag.name}
                                    onPress={() => toggleTag(tag.id)}
                                    selected={draft.tagIds.includes(tag.id)}
                                />
                            ))}
                            {allTags.length === 0 ? <Text style={styles.empty}>{t('sidebarLists.noTags')}</Text> : null}
                        </View>
                    )}
                </View>
            </ScrollView>
            <View style={styles.dialogFooter}>
                <Pressable onPress={onClose} style={({ pressed }) => [styles.button, styles.secondaryButton, pressed && styles.secondaryButtonPressed]} testID="organize-session-cancel">
                    <Text style={styles.secondaryButtonText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    onPress={() => { onSave(draft, createdTags); onClose(); }}
                    style={[styles.button, styles.primaryButton]}
                    testID="organize-session-save"
                >
                    <Text style={styles.primaryButtonText}>{t('common.save')}</Text>
                </Pressable>
            </View>
        </DesktopDialogFrame>
    );
}

function AssignmentChoice({ label, onPress, selected }: { label: string; onPress: () => void; selected: boolean }) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            aria-checked={selected}
            accessibilityLabel={label}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={onPress}
            style={styles.assignmentRow}
        >
            <View style={[styles.check, selected && styles.checkSelected]}>
                {selected ? <Feather color={theme.colors.button.primary.tint} name="check" size={13} /> : null}
            </View>
            <Text style={styles.assignmentLabel}>{label}</Text>
        </Pressable>
    );
}

function TagChoice({ color, disabled, label, onPress, selected }: { color: string; disabled: boolean; label: string; onPress: () => void; selected: boolean }) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            aria-checked={selected}
            accessibilityLabel={label}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected, disabled }}
            disabled={disabled}
            onPress={onPress}
            style={[styles.assignmentRow, disabled && styles.tagResultDisabled]}
        >
            <View style={[styles.check, selected && styles.checkSelected]}>
                {selected ? <Feather color={theme.colors.button.primary.tint} name="check" size={13} /> : null}
            </View>
            <View style={[styles.tagDot, { backgroundColor: color }]} />
            <Text style={styles.assignmentLabel}>#{label}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    dialogBody: { padding: 16 },
    field: { gap: 7, marginBottom: 16 },
    fieldLabel: { color: theme.colors.textSecondary, fontSize: 12, ...Typography.default('semiBold') },
    assignmentRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 9,
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 40,
        },
    },
    check: { alignItems: 'center', borderColor: theme.colors.divider, borderRadius: 5, borderWidth: 1, height: 20, justifyContent: 'center', width: 20 },
    checkSelected: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    assignmentLabel: { color: theme.colors.text, flex: 1, fontSize: 13, ...Typography.default() },
    tagDot: { borderRadius: 3, height: 6, width: 6 },
    selectedTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    selectedTag: {
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceSelected,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 5,
        minHeight: 30,
        maxWidth: '100%',
        paddingHorizontal: 9,
    },
    selectedTagPressed: { backgroundColor: theme.colors.surfacePressed },
    selectedTagText: { color: theme.colors.text, flexShrink: 1, fontSize: 12, ...Typography.default('semiBold') },
    tagInput: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 7,
        borderWidth: StyleSheet.hairlineWidth,
        color: theme.colors.text,
        fontSize: 14,
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 40,
        },
        paddingHorizontal: 11,
        paddingVertical: 8,
        ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as any : {}),
    },
    tagInputFocused: { backgroundColor: theme.colors.surfaceSelected, borderColor: theme.colors.accent },
    tagResults: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 9,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
        padding: 4,
    },
    tagResult: { alignItems: 'center', borderRadius: 7, flexDirection: 'row', gap: 9, minHeight: 40, paddingHorizontal: 10 },
    tagResultActive: { backgroundColor: theme.colors.surfaceSelected },
    tagResultDisabled: { opacity: 0.45 },
    tagResultText: { color: theme.colors.text, flex: 1, fontSize: 13, ...Typography.default() },
    empty: { color: theme.colors.textSecondary, fontSize: 12, paddingHorizontal: 12, paddingVertical: 12, ...Typography.default() },
    dialogFooter: { borderTopColor: theme.colors.divider, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, justifyContent: 'flex-end', padding: 12 },
    button: {
        alignItems: 'center',
        borderRadius: 7,
        justifyContent: 'center',
        minHeight: {
            [mq.only.width(0, 768)]: 44,
            [mq.only.width(768)]: 36,
        },
        minWidth: 76,
        paddingHorizontal: 14,
    },
    secondaryButton: { backgroundColor: theme.colors.surface },
    secondaryButtonPressed: { backgroundColor: theme.colors.surfacePressed },
    primaryButton: { backgroundColor: theme.colors.button.primary.background },
    secondaryButtonText: { color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') },
    primaryButtonText: { color: theme.colors.button.primary.tint, fontSize: 13, ...Typography.default('semiBold') },
}));
