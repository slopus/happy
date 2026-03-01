import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator, TextInput, Platform, ScrollView } from 'react-native';
import {
    BottomSheetModal,
    BottomSheetBackdrop,
    BottomSheetScrollView,
    BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { showToast } from '@/components/Toast';
import { Switch } from '@/components/Switch';
import { storage, useDootaskProfile } from '@/sync/storage';
import { dootaskFetchColumnTemplates, dootaskCreateProject, isTokenExpired } from '@/sync/dootask/api';
import type { CreateProjectParams, DooTaskColumnTemplate } from '@/sync/dootask/types';

const SheetTextInput = Platform.OS === 'web' ? TextInput : BottomSheetTextInput;
const SheetScrollView = Platform.OS === 'web' ? ScrollView : BottomSheetScrollView;

// --- Main Component ---

export const DooTaskCreateProjectSheet = React.memo(
    React.forwardRef<BottomSheetModal, {}>((_props, ref) => {
        const { theme } = useUnistyles();
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

        // Reset form
        const resetForm = React.useCallback(() => {
            setProjectName('');
            setProjectDesc('');
            setSelectedTemplate(null);
            setWorkflowEnabled(true);
            setTemplates([]);
            setError(null);
            setTemplateExpanded(false);
        }, []);

        // Load column templates
        const loadTemplates = React.useCallback(async () => {
            if (!profile) return;
            setLoadingTemplates(true);
            setError(null);
            try {
                const res = await dootaskFetchColumnTemplates(profile.serverUrl, profile.token);
                if (res.ret === 1) {
                    const list: DooTaskColumnTemplate[] = (res.data || []).map((tpl: any) => ({
                        name: tpl.name,
                        columns: tpl.columns || [],
                    }));
                    setTemplates(list);
                }
            } catch {
                // Non-critical, silently fail
            } finally {
                setLoadingTemplates(false);
            }
        }, [profile]);

        // On sheet present: initialize
        const handleSheetChange = React.useCallback((index: number) => {
            if (index >= 0) {
                loadTemplates();
            }
        }, [loadTemplates]);

        // On dismiss: reset form
        const handleDismiss = React.useCallback(() => {
            resetForm();
        }, [resetForm]);

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
                    (ref as React.RefObject<BottomSheetModal>).current?.dismiss();
                } else {
                    setError(res.msg || t('dootask.createFailed'));
                }
            } catch {
                setError(t('dootask.createFailed'));
            } finally {
                setSubmitting(false);
            }
        }, [profile, projectName, projectDesc, selectedTemplate, workflowEnabled, isValid, ref]);

        const renderBackdrop = React.useCallback(
            (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
            [],
        );

        // No profile means can't create
        if (!profile) return null;

        return (
            <BottomSheetModal
                ref={ref}
                snapPoints={['70%']}
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
                <SheetScrollView
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* Title */}
                    <View style={[styles.titleRow, { borderBottomColor: theme.colors.divider }]}>
                        <Text style={[styles.titleText, { color: theme.colors.text }]}>
                            {t('dootask.createProject')}
                        </Text>
                    </View>

                    {/* Project name */}
                    <View>
                        <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>
                            {t('dootask.projectName') + ' *'}
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
                            placeholder={t('dootask.projectNamePlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={projectName}
                            onChangeText={setProjectName}
                            autoCorrect={false}
                            maxLength={32}
                        />
                        {projectName.length > 0 && projectName.trim().length < 2 && (
                            <Text style={[styles.validationText, { color: theme.colors.deleteAction }]}>
                                {t('dootask.nameTooShort')}
                            </Text>
                        )}
                        {projectName.trim().length > 32 && (
                            <Text style={[styles.validationText, { color: theme.colors.deleteAction }]}>
                                {t('dootask.nameTooLong')}
                            </Text>
                        )}
                    </View>

                    {/* Column Template selector */}
                    <View>
                        <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>
                            {t('dootask.columnTemplate')}
                        </Text>
                        <Pressable
                            style={[styles.fieldRow, { backgroundColor: theme.colors.groupped.background }]}
                            onPress={() => !loadingTemplates && setTemplateExpanded(!templateExpanded)}
                        >
                            {loadingTemplates ? (
                                <ActivityIndicator size="small" />
                            ) : (
                                <>
                                    <Text
                                        style={[styles.fieldValue, { color: selectedTemplate ? theme.colors.text : theme.colors.textSecondary }]}
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
                        {templateExpanded && !loadingTemplates && (
                            <View style={[styles.pickerList, { borderColor: theme.colors.divider }]}>
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
                    </View>

                    {/* Workflow toggle */}
                    <View>
                        <View style={styles.workflowRow}>
                            <View>
                                <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary, marginBottom: 0 }]}>
                                    {t('dootask.workflow')}
                                </Text>
                                <Text style={[styles.workflowStatus, { color: theme.colors.textSecondary }]}>
                                    {workflowEnabled ? t('dootask.workflowOn') : t('dootask.workflowOff')}
                                </Text>
                            </View>
                            <Switch
                                value={workflowEnabled}
                                onValueChange={setWorkflowEnabled}
                            />
                        </View>
                    </View>

                    {/* Project description */}
                    <View>
                        <Text style={[styles.fieldLabel, { color: theme.colors.textSecondary }]}>
                            {t('dootask.projectDescription')}
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
                        <Text style={styles.submitButtonText}>
                            {submitting ? t('dootask.creating') : t('dootask.addProject')}
                        </Text>
                    </Pressable>
                </SheetScrollView>
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
        paddingVertical: 0,
        height: 44,
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
    workflowRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    workflowStatus: {
        ...Typography.default(),
        fontSize: 12,
        marginTop: 2,
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
