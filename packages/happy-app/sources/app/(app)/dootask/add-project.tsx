/**
 * Add DooTask Project Page
 *
 * Standalone page for creating a new DooTask project.
 * Uses Settings/ItemGroup style layout.
 */

import * as React from 'react';
import { View, Text, ScrollView, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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
import { storage, useDootaskProfile } from '@/sync/storage';
import { dootaskFetchColumnTemplates, dootaskCreateProject, isTokenExpired } from '@/sync/dootask/api';
import type { CreateProjectParams, DooTaskColumnTemplate } from '@/sync/dootask/types';

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
    // Template picker
    pickerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 44,
        paddingHorizontal: 16,
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
        marginHorizontal: 16,
        marginBottom: 8,
        overflow: 'hidden',
    },
    templateOption: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 44,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    templateInfo: {
        flex: 1,
        marginRight: 8,
    },
    templateName: {
        ...Typography.default(),
        fontSize: 15,
    },
    templateColumns: {
        ...Typography.default(),
        fontSize: 12,
        marginTop: 2,
    },
    // Workflow
    workflowRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        minHeight: 44,
        paddingVertical: 8,
    },
    workflowLabel: {
        ...Typography.default(),
        fontSize: 15,
    },
    workflowStatus: {
        ...Typography.default(),
        fontSize: 12,
        marginTop: 2,
    },
}));

export default function AddProjectPage() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    const profile = useDootaskProfile();

    // Form state
    const [projectName, setProjectName] = React.useState('');
    const [projectDesc, setProjectDesc] = React.useState('');
    const [selectedTemplate, setSelectedTemplate] = React.useState<DooTaskColumnTemplate | null>(null);
    const [workflowEnabled, setWorkflowEnabled] = React.useState(true);

    // Data
    const [templates, setTemplates] = React.useState<DooTaskColumnTemplate[]>([]);
    const [loadingTemplates, setLoadingTemplates] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // Template picker expanded
    const [templateExpanded, setTemplateExpanded] = React.useState(false);

    // Validation
    const isValid = React.useMemo(() => {
        const trimmed = projectName.trim();
        return trimmed.length >= 2 && trimmed.length <= 32;
    }, [projectName]);

    // Load column templates on mount
    React.useEffect(() => {
        if (!profile) return;
        let cancelled = false;

        const load = async () => {
            setLoadingTemplates(true);
            try {
                const res = await dootaskFetchColumnTemplates(profile.serverUrl, profile.token);
                if (!cancelled && res.ret === 1) {
                    const list: DooTaskColumnTemplate[] = (res.data || []).map((tpl: any) => ({
                        name: tpl.name,
                        columns: tpl.columns || [],
                    }));
                    setTemplates(list);
                }
            } catch {
                // Non-critical, silently fail
            } finally {
                if (!cancelled) setLoadingTemplates(false);
            }
        };

        load();
        return () => { cancelled = true; };
    }, [profile]);

    // Submit
    const handleSubmit = React.useCallback(async () => {
        if (!profile || !isValid) return;

        setSubmitting(true);
        setError(null);

        try {
            const params: CreateProjectParams = {
                name: projectName.trim(),
                ...(projectDesc.trim() ? { desc: projectDesc.trim() } : {}),
                ...(selectedTemplate ? { columns: selectedTemplate.columns.join(',') } : {}),
                flow: workflowEnabled ? 'open' : 'close',
            };

            const res = await dootaskCreateProject(profile.serverUrl, profile.token, params);

            if (isTokenExpired(res)) {
                setError(t('dootask.tokenExpired'));
            } else if (res.ret === 1) {
                showToast(t('dootask.createSuccess'));
                storage.getState().refreshDootaskProjects();
                router.back();
            } else {
                setError(res.msg || t('dootask.createFailed'));
            }
        } catch {
            setError(t('dootask.createFailed'));
        } finally {
            setSubmitting(false);
        }
    }, [profile, projectName, projectDesc, selectedTemplate, workflowEnabled, isValid, router]);

    if (!profile) return null;

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
                {/* Project Name */}
                <ItemGroup title={t('dootask.projectName') + ' *'}>
                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={styles.input}
                            placeholder={t('dootask.projectNamePlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={projectName}
                            onChangeText={setProjectName}
                            autoCorrect={false}
                            maxLength={32}
                        />
                    </View>
                </ItemGroup>
                {projectName.length > 0 && projectName.trim().length < 2 && (
                    <Text style={[styles.validationText, { color: theme.colors.deleteAction }]}>
                        {t('dootask.nameTooShort')}
                    </Text>
                )}

                {/* Column Template */}
                <ItemGroup title={t('dootask.columnTemplate')}>
                    <Pressable
                        style={[styles.pickerRow, { backgroundColor: theme.colors.surface }]}
                        onPress={() => !loadingTemplates && setTemplateExpanded(!templateExpanded)}
                    >
                        {loadingTemplates ? (
                            <ActivityIndicator size="small" />
                        ) : (
                            <>
                                <Text
                                    style={[styles.pickerValue, { color: selectedTemplate ? theme.colors.text : theme.colors.textSecondary }]}
                                    numberOfLines={1}
                                >
                                    {selectedTemplate?.name ?? t('dootask.blankTemplate')}
                                </Text>
                                <Ionicons
                                    name={templateExpanded ? 'chevron-up' : 'chevron-down'}
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                            </>
                        )}
                    </Pressable>
                </ItemGroup>
                {templateExpanded && !loadingTemplates && (
                    <View style={[styles.pickerList, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surface }]}>
                        <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                            {/* Blank option */}
                            <Pressable
                                style={[
                                    styles.templateOption,
                                    !selectedTemplate && { backgroundColor: theme.colors.button.primary.background + '18' },
                                ]}
                                onPress={() => {
                                    setSelectedTemplate(null);
                                    setTemplateExpanded(false);
                                }}
                            >
                                <View style={styles.templateInfo}>
                                    <Text
                                        style={[styles.templateName, { color: theme.colors.text }]}
                                        numberOfLines={1}
                                    >
                                        {t('dootask.blankTemplate')}
                                    </Text>
                                </View>
                                {!selectedTemplate && <Ionicons name="checkmark" size={18} color={theme.colors.button.primary.background} />}
                            </Pressable>
                            {/* Template options */}
                            {templates.map((tpl, index) => {
                                const isSelected = selectedTemplate?.name === tpl.name;
                                return (
                                    <Pressable
                                        key={`${tpl.name}-${index}`}
                                        style={[
                                            styles.templateOption,
                                            isSelected && { backgroundColor: theme.colors.button.primary.background + '18' },
                                        ]}
                                        onPress={() => {
                                            setSelectedTemplate(tpl);
                                            setTemplateExpanded(false);
                                        }}
                                    >
                                        <View style={styles.templateInfo}>
                                            <Text
                                                style={[styles.templateName, { color: theme.colors.text }]}
                                                numberOfLines={1}
                                            >
                                                {tpl.name}
                                            </Text>
                                            {tpl.columns.length > 0 && (
                                                <Text
                                                    style={[styles.templateColumns, { color: theme.colors.textSecondary }]}
                                                    numberOfLines={1}
                                                >
                                                    {tpl.columns.join(', ')}
                                                </Text>
                                            )}
                                        </View>
                                        {isSelected && <Ionicons name="checkmark" size={18} color={theme.colors.button.primary.background} />}
                                    </Pressable>
                                );
                            })}
                        </ScrollView>
                    </View>
                )}

                {/* Workflow Toggle */}
                <ItemGroup title={t('dootask.workflow')}>
                    <View style={styles.workflowRow}>
                        <View>
                            <Text style={[styles.workflowLabel, { color: theme.colors.text }]}>
                                {workflowEnabled ? t('dootask.workflowOn') : t('dootask.workflowOff')}
                            </Text>
                        </View>
                        <Switch
                            value={workflowEnabled}
                            onValueChange={setWorkflowEnabled}
                        />
                    </View>
                </ItemGroup>

                {/* Project Description */}
                <ItemGroup title={t('dootask.projectDescription')}>
                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={[styles.input, styles.multilineInput]}
                            placeholder={t('dootask.projectDescriptionPlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={projectDesc}
                            onChangeText={setProjectDesc}
                            multiline
                            numberOfLines={4}
                            textAlignVertical="top"
                            maxLength={255}
                        />
                    </View>
                </ItemGroup>

                {/* Error */}
                {error && (
                    <Text style={[styles.errorText, { color: theme.colors.deleteAction }]}>
                        {error}
                    </Text>
                )}

                {/* Submit Button */}
                <Pressable
                    style={[styles.submitButton, (!isValid || submitting) && styles.submitButtonDisabled]}
                    onPress={handleSubmit}
                    disabled={!isValid || submitting}
                >
                    {submitting ? (
                        <ActivityIndicator color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={styles.submitButtonText}>{t('dootask.addProject')}</Text>
                    )}
                </Pressable>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
