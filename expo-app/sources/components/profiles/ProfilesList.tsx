import React from 'react';
import { View, Text, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';

import type { AIBackendProfile } from '@/sync/settings';
import { ProfileCompatibilityIcon } from '@/components/sessions/new/components/ProfileCompatibilityIcon';
import { ProfileRequirementsBadge } from '@/components/profiles/ProfileRequirementsBadge';
import { ignoreNextRowPress } from '@/utils/ui/ignoreNextRowPress';
import { toggleFavoriteProfileId } from '@/sync/profileGrouping';
import { buildProfileActions } from '@/components/profiles/profileActions';
import { getDefaultProfileListStrings, getProfileSubtitle, buildProfilesListGroups } from '@/components/profiles/profileListModel';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { hasRequiredSecret } from '@/sync/profileSecrets';
import { useSetting } from '@/sync/storage';
import { getEnabledAgentIds } from '@/agents/enabled';

export interface ProfilesListProps {
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    onFavoriteProfileIdsChange: (next: string[]) => void;
    experimentsEnabled: boolean;

    selectedProfileId: string | null;
    onPressProfile?: (profile: AIBackendProfile) => void | Promise<void>;
    onPressDefaultEnvironment?: () => void;

    machineId: string | null;

    includeDefaultEnvironmentRow?: boolean;
    includeAddProfileRow?: boolean;
    onAddProfilePress?: () => void;

    getProfileDisabled?: (profile: AIBackendProfile) => boolean;
    getProfileSubtitleExtra?: (profile: AIBackendProfile) => string | null;

    onEditProfile?: (profile: AIBackendProfile) => void;
    onDuplicateProfile?: (profile: AIBackendProfile) => void;
    onDeleteProfile?: (profile: AIBackendProfile) => void;
    getHasEnvironmentVariables?: (profile: AIBackendProfile) => boolean;
    onViewEnvironmentVariables?: (profile: AIBackendProfile) => void;
    extraActions?: (profile: AIBackendProfile) => ItemAction[];

    onSecretBadgePress?: (profile: AIBackendProfile) => void;

    groupTitles?: {
        favorites?: string;
        custom?: string;
        builtIn?: string;
    };
    builtInGroupFooter?: string;
    /**
     * Optional explicit boundary ref for row action popovers. Useful when this list is rendered
     * inside a scroll viewport (e.g. NewSessionWizard) and the popover should be clamped to the
     * visible portion of that scroll container.
     */
    popoverBoundaryRef?: React.RefObject<any> | null;
    /**
     * When provided, allows callers to mark API key requirements as satisfied via a saved/session key,
     * not only machine environment.
     */
    getSecretOverrideReady?: (profile: AIBackendProfile) => boolean;
    /**
     * When provided, supplies machine-env preflight readiness/loading for the profile's required secret env var.
     * This allows callers to batch/cache daemon env checks instead of doing one request per row.
     */
    getSecretMachineEnvOverride?: (profile: AIBackendProfile) => { isReady: boolean; isLoading: boolean } | null;
}

type ProfileRowProps = {
    profile: AIBackendProfile;
    displayName: string;
    isSelected: boolean;
    isFavorite: boolean;
    isDisabled: boolean;
    showDivider: boolean;
    isMobile: boolean;
    machineId: string | null;
    subtitleText: string;
    showMobileBadge: boolean;
    onPressProfile?: (profile: AIBackendProfile) => void | Promise<void>;
    onSecretBadgePress?: (profile: AIBackendProfile) => void;
    rightElement: React.ReactNode;
    ignoreRowPressRef: React.MutableRefObject<boolean>;
    getSecretOverrideReady?: (profile: AIBackendProfile) => boolean;
    getSecretMachineEnvOverride?: (profile: AIBackendProfile) => { isReady: boolean; isLoading: boolean } | null;
};

const ProfileRow = React.memo(function ProfileRow(props: ProfileRowProps) {
    const theme = useUnistyles().theme;

    const subtitle = React.useMemo(() => {
        if (!props.showMobileBadge) return props.subtitleText;
        return (
            <View style={{ gap: 6 }}>
                <Text
                    style={{
                        ...Typography.default('regular'),
                        color: theme.colors.textSecondary,
                        fontSize: Platform.select({ ios: 15, default: 14 }),
                        lineHeight: 20,
                        letterSpacing: Platform.select({ ios: -0.24, default: 0.1 }),
                    }}
                >
                    {props.subtitleText}
                </Text>
                <View style={{ alignSelf: 'flex-start' }}>
                    <ProfileRequirementsBadge
                        profile={props.profile}
                        machineId={props.machineId}
                        overrideReady={props.getSecretOverrideReady?.(props.profile) ?? false}
                        machineEnvOverride={props.getSecretMachineEnvOverride?.(props.profile) ?? null}
                        onPressIn={() => ignoreNextRowPress(props.ignoreRowPressRef)}
                        onPress={() => {
                            props.onSecretBadgePress?.(props.profile);
                        }}
                    />
                </View>
            </View>
        );
    }, [props.ignoreRowPressRef, props.machineId, props.onSecretBadgePress, props.profile, props.showMobileBadge, props.subtitleText, theme.colors.textSecondary]);

    const onPress = React.useCallback(() => {
        if (props.isDisabled) return;
        if (props.ignoreRowPressRef.current) {
            props.ignoreRowPressRef.current = false;
            return;
        }
        void props.onPressProfile?.(props.profile);
    }, [props.ignoreRowPressRef, props.isDisabled, props.onPressProfile, props.profile]);

    return (
        <Item
            key={props.profile.id}
            title={props.displayName}
            subtitle={subtitle}
            leftElement={<ProfileCompatibilityIcon profile={props.profile} />}
            showChevron={false}
            selected={props.isSelected}
            disabled={props.isDisabled}
            onPress={onPress}
            rightElement={props.rightElement}
            showDivider={props.showDivider}
        />
    );
});

export function ProfilesList(props: ProfilesListProps) {
    const { theme, rt } = useUnistyles();
    const experimentalAgents = useSetting('experimentalAgents');
    const enabledAgentIds = React.useMemo(() => {
        return getEnabledAgentIds({ experiments: props.experimentsEnabled, experimentalAgents });
    }, [experimentalAgents, props.experimentsEnabled]);
    const strings = React.useMemo(() => getDefaultProfileListStrings(enabledAgentIds), [enabledAgentIds]);
    const {
        extraActions,
        getHasEnvironmentVariables,
        onDeleteProfile,
        onDuplicateProfile,
        onEditProfile,
        onViewEnvironmentVariables,
    } = props;

    const ignoreRowPressRef = React.useRef(false);
    const selectedIndicatorColor = rt.themeName === 'dark' ? theme.colors.text : theme.colors.button.primary.background;
    const isMobile = useWindowDimensions().width < 580;

    const groups = React.useMemo(() => {
        return buildProfilesListGroups({ customProfiles: props.customProfiles, favoriteProfileIds: props.favoriteProfileIds, enabledAgentIds });
    }, [enabledAgentIds, props.customProfiles, props.favoriteProfileIds]);

    const isDefaultEnvironmentFavorite = groups.favoriteIds.has('');
    const showFavoritesGroup = groups.favoriteProfiles.length > 0 || (props.includeDefaultEnvironmentRow && isDefaultEnvironmentFavorite);

    const toggleFavorite = React.useCallback((profileId: string) => {
        props.onFavoriteProfileIdsChange(toggleFavoriteProfileId(props.favoriteProfileIds, profileId));
    }, [props.favoriteProfileIds, props.onFavoriteProfileIdsChange]);

    // Precompute action arrays so selection changes don't rebuild them for every row.
    const actionsByProfileId = React.useMemo(() => {
        const map = new Map<string, { actions: ItemAction[]; compactActionIds: string[] }>();

        const build = (profile: AIBackendProfile) => {
            const isFavorite = groups.favoriteIds.has(profile.id);
            const hasEnvVars = getHasEnvironmentVariables ? getHasEnvironmentVariables(profile) : false;
            const canViewEnvVars = hasEnvVars && Boolean(onViewEnvironmentVariables);
            const actions: ItemAction[] = [
                ...(extraActions ? extraActions(profile) : []),
                ...buildProfileActions({
                    profile,
                    isFavorite,
                    favoriteActionColor: selectedIndicatorColor,
                    nonFavoriteActionColor: theme.colors.textSecondary,
                    onToggleFavorite: () => toggleFavorite(profile.id),
                    onEdit: () => onEditProfile?.(profile),
                    onDuplicate: () => onDuplicateProfile?.(profile),
                    onDelete: onDeleteProfile ? () => onDeleteProfile?.(profile) : undefined,
                    onViewEnvironmentVariables: canViewEnvVars ? () => onViewEnvironmentVariables?.(profile) : undefined,
                }),
            ];
            const compactActionIds = ['favorite', ...(canViewEnvVars ? ['envVars'] : [])];
            map.set(profile.id, { actions, compactActionIds });
        };

        for (const p of groups.favoriteProfiles) build(p);
        for (const p of groups.customProfiles) build(p);
        for (const p of groups.builtInProfiles) build(p);

        return map;
    }, [
        groups.builtInProfiles,
        groups.customProfiles,
        groups.favoriteIds,
        groups.favoriteProfiles,
        extraActions,
        getHasEnvironmentVariables,
        onDeleteProfile,
        onDuplicateProfile,
        onEditProfile,
        onViewEnvironmentVariables,
        selectedIndicatorColor,
        theme.colors.textSecondary,
        toggleFavorite,
    ]);

    const renderDefaultEnvironmentRightElement = React.useCallback((isSelected: boolean) => {
        const isFavorite = isDefaultEnvironmentFavorite;
        const actions: ItemAction[] = [
            {
                id: 'favorite',
                title: isFavorite ? t('profiles.actions.removeFromFavorites') : t('profiles.actions.addToFavorites'),
                icon: isFavorite ? 'star' : 'star-outline',
                onPress: () => toggleFavorite(''),
                color: isFavorite ? selectedIndicatorColor : theme.colors.textSecondary,
            },
        ];

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="checkmark-circle" size={24} color={selectedIndicatorColor} style={{ opacity: isSelected ? 1 : 0 }} />
                </View>
                <ItemRowActions
                    title={t('profiles.noProfile')}
                    actions={actions}
                    compactActionIds={['favorite']}
                    pinnedActionIds={['favorite']}
                    overflowPosition="beforePinned"
                    iconSize={20}
                    onActionPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                    popoverBoundaryRef={props.popoverBoundaryRef}
                />
            </View>
        );
    }, [isDefaultEnvironmentFavorite, selectedIndicatorColor, theme.colors.textSecondary, toggleFavorite]);

    const renderProfileRightElement = React.useCallback((profile: AIBackendProfile, displayName: string, isSelected: boolean, isFavorite: boolean) => {
        const entry = actionsByProfileId.get(profile.id);
        const actions = entry?.actions ?? [];
        const compactActionIds = entry?.compactActionIds ?? ['favorite'];

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                {!isMobile && (
                    <ProfileRequirementsBadge
                        profile={profile}
                        machineId={props.machineId}
                        overrideReady={props.getSecretOverrideReady?.(profile) ?? false}
                        machineEnvOverride={props.getSecretMachineEnvOverride?.(profile) ?? null}
                        onPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                        onPress={props.onSecretBadgePress ? () => {
                            props.onSecretBadgePress?.(profile);
                        } : undefined}
                    />
                )}
                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="checkmark-circle" size={24} color={selectedIndicatorColor} style={{ opacity: isSelected ? 1 : 0 }} />
                </View>
                <ItemRowActions
                    title={displayName}
                    actions={actions}
                    compactActionIds={compactActionIds}
                    pinnedActionIds={['favorite']}
                    overflowPosition="beforePinned"
                    iconSize={20}
                    onActionPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                    popoverBoundaryRef={props.popoverBoundaryRef}
                />
            </View>
        );
    }, [
        actionsByProfileId,
        isMobile,
        props,
        selectedIndicatorColor,
    ]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {showFavoritesGroup && (
                <ItemGroup
                    title={props.groupTitles?.favorites ?? t('profiles.groups.favorites')}
                    selectableItemCountOverride={Math.max(
                        1,
                        (props.includeDefaultEnvironmentRow && isDefaultEnvironmentFavorite ? 1 : 0) + groups.favoriteProfiles.length,
                    )}
                >
                    {props.includeDefaultEnvironmentRow && isDefaultEnvironmentFavorite && (
                        <Item
                            title={t('profiles.noProfile')}
                            subtitle={t('profiles.noProfileDescription')}
                            leftElement={<Ionicons name="home-outline" size={29} color={theme.colors.textSecondary} />}
                            showChevron={false}
                            selected={!props.selectedProfileId}
                            onPress={() => {
                                if (ignoreRowPressRef.current) {
                                    ignoreRowPressRef.current = false;
                                    return;
                                }
                                props.onPressDefaultEnvironment?.();
                            }}
                            rightElement={renderDefaultEnvironmentRightElement(!props.selectedProfileId)}
                            showDivider={groups.favoriteProfiles.length > 0}
                        />
                    )}
                    {groups.favoriteProfiles.map((profile, index) => {
                        const displayName = getProfileDisplayName(profile);
                        const isLast = index === groups.favoriteProfiles.length - 1;
                        const isSelected = props.selectedProfileId === profile.id;
                        const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
                        const baseSubtitle = getProfileSubtitle({ profile, enabledAgentIds, strings });
                        const extra = props.getProfileSubtitleExtra?.(profile);
                        const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
                        const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onSecretBadgePress);
                        return (
                            <ProfileRow
                                key={profile.id}
                                profile={profile}
                                displayName={displayName}
                                isSelected={isSelected}
                                isFavorite={true}
                                isDisabled={isDisabled}
                                showDivider={!isLast}
                                isMobile={isMobile}
                                machineId={props.machineId}
                                subtitleText={subtitleText}
                                showMobileBadge={showMobileBadge}
                                onPressProfile={props.onPressProfile}
                                onSecretBadgePress={props.onSecretBadgePress}
                                rightElement={renderProfileRightElement(profile, displayName, isSelected, true)}
                                ignoreRowPressRef={ignoreRowPressRef}
                                getSecretOverrideReady={props.getSecretOverrideReady}
                                getSecretMachineEnvOverride={props.getSecretMachineEnvOverride}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            {groups.customProfiles.length > 0 && (
                <ItemGroup
                    title={props.groupTitles?.custom ?? t('profiles.groups.custom')}
                    selectableItemCountOverride={Math.max(2, groups.customProfiles.length)}
                >
                    {groups.customProfiles.map((profile, index) => {
                        const displayName = getProfileDisplayName(profile);
                        const isLast = index === groups.customProfiles.length - 1;
                        const isFavorite = groups.favoriteIds.has(profile.id);
                        const isSelected = props.selectedProfileId === profile.id;
                        const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
                        const baseSubtitle = getProfileSubtitle({ profile, enabledAgentIds, strings });
                        const extra = props.getProfileSubtitleExtra?.(profile);
                        const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
                        const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onSecretBadgePress);
                        return (
                            <ProfileRow
                                key={profile.id}
                                profile={profile}
                                displayName={displayName}
                                isSelected={isSelected}
                                isFavorite={isFavorite}
                                isDisabled={isDisabled}
                                showDivider={!isLast}
                                isMobile={isMobile}
                                machineId={props.machineId}
                                subtitleText={subtitleText}
                                showMobileBadge={showMobileBadge}
                                onPressProfile={props.onPressProfile}
                                onSecretBadgePress={props.onSecretBadgePress}
                                rightElement={renderProfileRightElement(profile, displayName, isSelected, isFavorite)}
                                ignoreRowPressRef={ignoreRowPressRef}
                                getSecretOverrideReady={props.getSecretOverrideReady}
                                getSecretMachineEnvOverride={props.getSecretMachineEnvOverride}
                            />
                        );
                    })}
                </ItemGroup>
            )}

            <ItemGroup
                title={props.groupTitles?.builtIn ?? t('profiles.groups.builtIn')}
                footer={props.builtInGroupFooter}
                selectableItemCountOverride={
                    Math.max(
                        1,
                        (props.includeDefaultEnvironmentRow && !isDefaultEnvironmentFavorite ? 1 : 0) + groups.builtInProfiles.length,
                    )
                }
            >
                {props.includeDefaultEnvironmentRow && !isDefaultEnvironmentFavorite && (
                    <Item
                        title={t('profiles.noProfile')}
                        subtitle={t('profiles.noProfileDescription')}
                        leftElement={<Ionicons name="home-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                        selected={!props.selectedProfileId}
                        onPress={() => {
                            if (ignoreRowPressRef.current) {
                                ignoreRowPressRef.current = false;
                                return;
                            }
                            props.onPressDefaultEnvironment?.();
                        }}
                        rightElement={renderDefaultEnvironmentRightElement(!props.selectedProfileId)}
                        showDivider={groups.builtInProfiles.length > 0}
                    />
                )}
                {groups.builtInProfiles.map((profile, index) => {
                    const displayName = getProfileDisplayName(profile);
                    const isLast = index === groups.builtInProfiles.length - 1;
                    const isFavorite = groups.favoriteIds.has(profile.id);
                    const isSelected = props.selectedProfileId === profile.id;
                    const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
                    const baseSubtitle = getProfileSubtitle({ profile, enabledAgentIds, strings });
                    const extra = props.getProfileSubtitleExtra?.(profile);
                    const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
                    const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onSecretBadgePress);
                    return (
                        <ProfileRow
                            key={profile.id}
                            profile={profile}
                            displayName={displayName}
                            isSelected={isSelected}
                            isFavorite={isFavorite}
                            isDisabled={isDisabled}
                            showDivider={!isLast}
                            isMobile={isMobile}
                            machineId={props.machineId}
                            subtitleText={subtitleText}
                            showMobileBadge={showMobileBadge}
                            onPressProfile={props.onPressProfile}
                            onSecretBadgePress={props.onSecretBadgePress}
                            rightElement={renderProfileRightElement(profile, displayName, isSelected, isFavorite)}
                            ignoreRowPressRef={ignoreRowPressRef}
                            getSecretOverrideReady={props.getSecretOverrideReady}
                            getSecretMachineEnvOverride={props.getSecretMachineEnvOverride}
                        />
                    );
                })}
            </ItemGroup>

            {props.includeAddProfileRow && props.onAddProfilePress && (
                <ItemGroup title="" selectableItemCountOverride={1}>
                    <Item
                        title={t('profiles.addProfile')}
                        subtitle={t('profiles.subtitle')}
                        leftElement={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.secondary.tint} />}
                        onPress={props.onAddProfilePress}
                        showChevron={false}
                        showDivider={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
