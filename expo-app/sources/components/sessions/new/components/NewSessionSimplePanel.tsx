import * as React from 'react';
import type { ViewStyle } from 'react-native';
import { Platform, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SessionTypeSelectorRows } from '@/components/SessionTypeSelector';
import { layout } from '@/components/layout';
import { AgentInput } from '@/components/sessions/agentInput';
import { PopoverBoundaryProvider } from '@/components/ui/popover';
import { PopoverPortalTargetProvider } from '@/components/ui/popover';
import { t } from '@/text';

export function NewSessionSimplePanel(props: Readonly<{
    popoverBoundaryRef: React.RefObject<View>;
    headerHeight: number;
    safeAreaTop: number;
    safeAreaBottom: number;
    newSessionSidePadding: number;
    newSessionBottomPadding: number;
    containerStyle: ViewStyle;
    experimentsEnabled: boolean;
    expSessionType: boolean;
    sessionType: 'simple' | 'worktree';
    setSessionType: (t: 'simple' | 'worktree') => void;
    sessionPrompt: string;
    setSessionPrompt: (v: string) => void;
    handleCreateSession: () => void;
    canCreate: boolean;
    isCreating: boolean;
    emptyAutocompletePrefixes: React.ComponentProps<typeof AgentInput>['autocompletePrefixes'];
    emptyAutocompleteSuggestions: React.ComponentProps<typeof AgentInput>['autocompleteSuggestions'];
    sessionPromptInputMaxHeight: number;
    agentInputExtraActionChips?: React.ComponentProps<typeof AgentInput>['extraActionChips'];
    agentType: React.ComponentProps<typeof AgentInput>['agentType'];
    handleAgentClick: React.ComponentProps<typeof AgentInput>['onAgentClick'];
    permissionMode: React.ComponentProps<typeof AgentInput>['permissionMode'];
    handlePermissionModeChange: React.ComponentProps<typeof AgentInput>['onPermissionModeChange'];
    modelMode: React.ComponentProps<typeof AgentInput>['modelMode'];
    setModelMode: React.ComponentProps<typeof AgentInput>['onModelModeChange'];
    connectionStatus: React.ComponentProps<typeof AgentInput>['connectionStatus'];
    machineName: string | undefined;
    handleMachineClick: React.ComponentProps<typeof AgentInput>['onMachineClick'];
    selectedPath: string;
    handlePathClick: React.ComponentProps<typeof AgentInput>['onPathClick'];
    showResumePicker: boolean;
    resumeSessionId: string | null;
    handleResumeClick: React.ComponentProps<typeof AgentInput>['onResumeClick'];
    isResumeSupportChecking: boolean;
    useProfiles: boolean;
    selectedProfileId: string | null;
    handleProfileClick: React.ComponentProps<typeof AgentInput>['onProfileClick'];
    selectedProfileEnvVarsCount: number;
    handleEnvVarsClick: () => void;
}>): React.ReactElement {
    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? props.headerHeight + props.safeAreaBottom + 16 : 0}
            style={[
                props.containerStyle,
                ...(Platform.OS === 'web'
                    ? [
                        {
                            justifyContent: 'center' as const,
                            paddingTop: 0,
                        },
                    ]
                    : [
                        {
                            justifyContent: 'flex-end' as const,
                            paddingTop: 40,
                        },
                    ]),
            ]}
        >
            <View
                ref={props.popoverBoundaryRef}
                style={{
                    flex: 1,
                    width: '100%',
                    // Keep the content centered on web. Without this, the boundary wrapper (flex:1)
                    // can cause the inner content to stick to the top even when the modal is centered.
                    justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
                }}
            >
                <PopoverPortalTargetProvider>
                    <PopoverBoundaryProvider boundaryRef={props.popoverBoundaryRef}>
                        <View
                            style={{
                                width: '100%',
                                alignSelf: 'center',
                                paddingTop: props.safeAreaTop,
                                paddingBottom: props.safeAreaBottom,
                            }}
                        >
                            {/* Session type selector only if enabled via experiments */}
                            {props.experimentsEnabled && props.expSessionType && (
                                <View style={{ paddingHorizontal: props.newSessionSidePadding, marginBottom: 16 }}>
                                    <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                                        <ItemGroup title={t('newSession.sessionType.title')} containerStyle={{ marginHorizontal: 0 }}>
                                            <SessionTypeSelectorRows value={props.sessionType} onChange={props.setSessionType} />
                                        </ItemGroup>
                                    </View>
                                </View>
                            )}

                            {/* AgentInput with inline chips - sticky at bottom */}
                            <View
                                style={{
                                    paddingTop: 12,
                                    paddingBottom: props.newSessionBottomPadding,
                                }}
                            >
                                <View style={{ paddingHorizontal: props.newSessionSidePadding }}>
                                    <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center' }}>
                                        <AgentInput
                                            value={props.sessionPrompt}
                                            onChangeText={props.setSessionPrompt}
                                            onSend={props.handleCreateSession}
                                            isSendDisabled={!props.canCreate}
                                            isSending={props.isCreating}
                                            placeholder={t('session.inputPlaceholder')}
                                            autocompletePrefixes={props.emptyAutocompletePrefixes}
                                            autocompleteSuggestions={props.emptyAutocompleteSuggestions}
                                            extraActionChips={props.agentInputExtraActionChips}
                                            inputMaxHeight={props.sessionPromptInputMaxHeight}
                                            agentType={props.agentType}
                                            onAgentClick={props.handleAgentClick}
                                            permissionMode={props.permissionMode}
                                            onPermissionModeChange={props.handlePermissionModeChange}
                                            modelMode={props.modelMode}
                                            onModelModeChange={props.setModelMode}
                                            connectionStatus={props.connectionStatus}
                                            machineName={props.machineName}
                                            onMachineClick={props.handleMachineClick}
                                            currentPath={props.selectedPath}
                                            onPathClick={props.handlePathClick}
                                            resumeSessionId={props.showResumePicker ? props.resumeSessionId : undefined}
                                            onResumeClick={props.showResumePicker ? props.handleResumeClick : undefined}
                                            resumeIsChecking={props.isResumeSupportChecking}
                                            contentPaddingHorizontal={0}
                                            {...(props.useProfiles
                                                ? {
                                                    profileId: props.selectedProfileId,
                                                    onProfileClick: props.handleProfileClick,
                                                    envVarsCount: props.selectedProfileEnvVarsCount || undefined,
                                                    onEnvVarsClick: props.selectedProfileEnvVarsCount > 0 ? props.handleEnvVarsClick : undefined,
                                                }
                                                : {})}
                                        />
                                    </View>
                                </View>
                            </View>
                        </View>
                    </PopoverBoundaryProvider>
                </PopoverPortalTargetProvider>
            </View>
        </KeyboardAvoidingView>
    );
}
