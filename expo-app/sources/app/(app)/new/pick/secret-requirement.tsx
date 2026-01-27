import React from 'react';
import { Platform } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useSetting, useSettingMutable } from '@/sync/storage';
import { getBuiltInProfile } from '@/sync/profileUtils';
import { SecretRequirementScreen, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { storeTempData } from '@/utils/tempDataStore';
import { PopoverPortalTargetProvider } from '@/components/ui/popover';

type SecretRequirementRoutePayload = Readonly<{
    profileId: string;
    revertOnCancel: boolean;
    result: SecretRequirementModalResult;
}>;

function parseUpperEnvVarList(raw: unknown): string[] {
    if (typeof raw !== 'string') return [];
    return raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
}

function parseJsonRecord(raw: unknown): Record<string, string | null | undefined> {
    if (typeof raw !== 'string' || raw.length === 0) return {};
    try {
        const decoded = decodeURIComponent(raw);
        const parsed = JSON.parse(decoded);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed as Record<string, string | null | undefined>;
    } catch {
        return {};
    }
}

function dispatchSetParamsToPreviousRoute(navigation: any, params: Record<string, any>): boolean {
    const state = navigation?.getState?.();
    const previousRoute = state?.routes?.[state.index - 1];
    if (!state || typeof state.index !== 'number' || state.index <= 0 || !previousRoute?.key) {
        return false;
    }

    navigation.dispatch({
        type: 'SET_PARAMS',
        payload: { params },
        source: previousRoute.key,
    });
    return true;
}

export default React.memo(function SecretRequirementPickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        profileId?: string;
        secretEnvVarName?: string;
        secretEnvVarNames?: string;
        machineId?: string;
        revertOnCancel?: string;
        selectedSecretIdByEnvVarName?: string;
    }>();

    const profileId = typeof params.profileId === 'string' ? params.profileId : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId : null;
    const revertOnCancel = params.revertOnCancel === '1';

    const profiles = useSetting('profiles');
    const [secrets, setSecrets] = useSettingMutable('secrets');
    const [secretBindingsByProfileId, setSecretBindingsByProfileId] = useSettingMutable('secretBindingsByProfileId');

    const profile =
        profiles.find((p) => p.id === profileId) ??
        (profileId ? getBuiltInProfile(profileId) : null);

    const secretEnvVarName = typeof params.secretEnvVarName === 'string'
        ? params.secretEnvVarName.trim().toUpperCase()
        : '';
    const secretEnvVarNames = parseUpperEnvVarList(params.secretEnvVarNames);

    const selectedSecretIdByEnvVarName = React.useMemo(() => {
        return parseJsonRecord(params.selectedSecretIdByEnvVarName);
    }, [params.selectedSecretIdByEnvVarName]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: false,
            presentation: Platform.OS === 'ios' ? 'containedTransparentModal' : undefined,
        } as const;
    }, []);

    const didSendResultRef = React.useRef(false);

    const sendResultToNewSession = React.useCallback((result: SecretRequirementModalResult) => {
        if (!profileId) return;
        if (didSendResultRef.current) return;
        didSendResultRef.current = true;

        const payload: SecretRequirementRoutePayload = {
            profileId,
            revertOnCancel,
            result,
        };
        const id = storeTempData(payload);

        const didSet = dispatchSetParamsToPreviousRoute(navigation as any, { secretRequirementResultId: id });
        if (!didSet) {
            router.replace({ pathname: '/new', params: { secretRequirementResultId: id } } as any);
            return;
        }
        router.back();
    }, [navigation, profileId, revertOnCancel, router]);

    const handleCancel = React.useCallback(() => {
        sendResultToNewSession({ action: 'cancel' });
    }, [sendResultToNewSession]);

    React.useEffect(() => {
        const sub = (navigation as any)?.addListener?.('beforeRemove', () => {
            if (didSendResultRef.current) return;
            sendResultToNewSession({ action: 'cancel' });
        });
        return () => sub?.();
    }, [navigation, sendResultToNewSession]);

    if (!profile || !secretEnvVarName) {
        return (
            <>
                <Stack.Screen
                    options={screenOptions}
                />
            </>
        );
    }

    const defaultBindingsForProfile = secretBindingsByProfileId?.[profile.id] ?? null;

    return (
        <PopoverPortalTargetProvider>
            <>
                <Stack.Screen
                    options={screenOptions}
                />

                <SecretRequirementScreen
                    profile={profile}
                    secretEnvVarName={secretEnvVarName}
                    secretEnvVarNames={secretEnvVarNames.length > 0 ? secretEnvVarNames : undefined}
                    machineId={machineId}
                    secrets={secrets}
                    defaultSecretId={defaultBindingsForProfile?.[secretEnvVarName] ?? null}
                    selectedSavedSecretId={
                        typeof selectedSecretIdByEnvVarName?.[secretEnvVarName] === 'string' &&
                            String(selectedSecretIdByEnvVarName?.[secretEnvVarName]).trim().length > 0
                            ? (selectedSecretIdByEnvVarName?.[secretEnvVarName] as string)
                            : null
                    }
                    selectedSecretIdByEnvVarName={selectedSecretIdByEnvVarName}
                    defaultSecretIdByEnvVarName={defaultBindingsForProfile}
                    onSetDefaultSecretId={(id) => {
                        if (!id) return;
                        setSecretBindingsByProfileId({
                            ...secretBindingsByProfileId,
                            [profile.id]: {
                                ...(secretBindingsByProfileId?.[profile.id] ?? {}),
                                [secretEnvVarName]: id,
                            },
                        });
                    }}
                    onChangeSecrets={setSecrets}
                    allowSessionOnly={true}
                    onResolve={sendResultToNewSession}
                    onRequestClose={handleCancel}
                    onClose={handleCancel}
                />
            </>
        </PopoverPortalTargetProvider>
    );
});
