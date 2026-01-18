import React from 'react';
import { View, Text, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { ItemRowActions } from '@/components/ItemRowActions';
import type { ItemAction } from '@/components/ItemActionsMenuModal';

import type { AIBackendProfile } from '@/sync/settings';
import { ProfileCompatibilityIcon } from '@/components/newSession/ProfileCompatibilityIcon';
import { ProfileRequirementsBadge } from '@/components/ProfileRequirementsBadge';
import { ignoreNextRowPress } from '@/utils/ignoreNextRowPress';
import { toggleFavoriteProfileId } from '@/sync/profileGrouping';
import { buildProfileActions } from '@/components/profileActions';
import { getDefaultProfileListStrings, getProfileSubtitle, buildProfilesListGroups } from '@/components/profiles/profileListModel';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { hasRequiredSecret } from '@/sync/profileSecrets';
import { useSetting } from '@/sync/storage';

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

    onApiKeyBadgePress?: (profile: AIBackendProfile) => void;

    groupTitles?: {
        favorites?: string;
        custom?: string;
        builtIn?: string;
    };
    builtInGroupFooter?: string;
}

type ProfileRowProps = {
    profile: AIBackendProfile;
    isSelected: boolean;
    isFavorite: boolean;
    isDisabled: boolean;
    showDivider: boolean;
    isMobile: boolean;
    machineId: string | null;
    experimentsEnabled: boolean;
    subtitleText: string;
    showMobileBadge: boolean;
    onPressProfile?: (profile: AIBackendProfile) => void | Promise<void>;
    onApiKeyBadgePress?: (profile: AIBackendProfile) => void;
    rightElement: React.ReactNode;
    ignoreRowPressRef: React.MutableRefObject<boolean>;
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
                        onPressIn={() => ignoreNextRowPress(props.ignoreRowPressRef)}
                        onPress={() => {
                            props.onApiKeyBadgePress?.(props.profile);
                        }}
                    />
                </View>
            </View>
        );
    }, [props.ignoreRowPressRef, props.machineId, props.onApiKeyBadgePress, props.profile, props.showMobileBadge, props.subtitleText, theme.colors.textSecondary]);

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
            title={props.profile.name}
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
    const strings = React.useMemo(() => getDefaultProfileListStrings(), []);
    const expGemini = useSetting('expGemini');
    const allowGemini = props.experimentsEnabled && expGemini;
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
    const isMobile = Platform.OS === 'ios' || Platform.OS === 'android';

    const groups = React.useMemo(() => {
        return buildProfilesListGroups({ customProfiles: props.customProfiles, favoriteProfileIds: props.favoriteProfileIds });
    }, [props.customProfiles, props.favoriteProfileIds]);

    const isDefaultEnvironmentFavorite = groups.favoriteIds.has('');

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
                    iconSize={20}
                    onActionPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                />
            </View>
        );
    }, [isDefaultEnvironmentFavorite, selectedIndicatorColor, theme.colors.textSecondary, toggleFavorite]);

    const renderProfileRightElement = React.useCallback((profile: AIBackendProfile, isSelected: boolean, isFavorite: boolean) => {
        const entry = actionsByProfileId.get(profile.id);
        const actions = entry?.actions ?? [];
        const compactActionIds = entry?.compactActionIds ?? ['favorite'];

        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                {!isMobile && (
                    <ProfileRequirementsBadge
                        profile={profile}
                        machineId={props.machineId}
                        onPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
                        onPress={props.onApiKeyBadgePress ? () => {
                            props.onApiKeyBadgePress?.(profile);
                        } : undefined}
                    />
                )}
                <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="checkmark-circle" size={24} color={selectedIndicatorColor} style={{ opacity: isSelected ? 1 : 0 }} />
                </View>
                <ItemRowActions
                    title={profile.name}
                    actions={actions}
                    compactActionIds={compactActionIds}
                    iconSize={20}
                    onActionPressIn={() => ignoreNextRowPress(ignoreRowPressRef)}
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
            {(props.includeDefaultEnvironmentRow || groups.favoriteProfiles.length > 0 || isDefaultEnvironmentFavorite) && (
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
                        const isLast = index === groups.favoriteProfiles.length - 1;
                        const isSelected = props.selectedProfileId === profile.id;
                        const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
                        const baseSubtitle = getProfileSubtitle({ profile, experimentsEnabled: allowGemini, strings });
                        const extra = props.getProfileSubtitleExtra?.(profile);
                        const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
                        const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onApiKeyBadgePress);
                        return (
                            <ProfileRow
                                key={profile.id}
                                profile={profile}
                                isSelected={isSelected}
                                isFavorite={true}
                                isDisabled={isDisabled}
                                showDivider={!isLast}
                                isMobile={isMobile}
                                machineId={props.machineId}
                                experimentsEnabled={allowGemini}
                                subtitleText={subtitleText}
                                showMobileBadge={showMobileBadge}
                                onPressProfile={props.onPressProfile}
                                onApiKeyBadgePress={props.onApiKeyBadgePress}
                                rightElement={renderProfileRightElement(profile, isSelected, true)}
                                ignoreRowPressRef={ignoreRowPressRef}
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
                        const isLast = index === groups.customProfiles.length - 1;
                        const isFavorite = groups.favoriteIds.has(profile.id);
                        const isSelected = props.selectedProfileId === profile.id;
                        const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
                        const baseSubtitle = getProfileSubtitle({ profile, experimentsEnabled: allowGemini, strings });
                        const extra = props.getProfileSubtitleExtra?.(profile);
                        const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
                        const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onApiKeyBadgePress);
                        return (
                            <ProfileRow
                                key={profile.id}
                                profile={profile}
                                isSelected={isSelected}
                                isFavorite={isFavorite}
                                isDisabled={isDisabled}
                                showDivider={!isLast}
                                isMobile={isMobile}
                                machineId={props.machineId}
                                experimentsEnabled={allowGemini}
                                subtitleText={subtitleText}
                                showMobileBadge={showMobileBadge}
                                onPressProfile={props.onPressProfile}
                                onApiKeyBadgePress={props.onApiKeyBadgePress}
                                rightElement={renderProfileRightElement(profile, isSelected, isFavorite)}
                                ignoreRowPressRef={ignoreRowPressRef}
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
                    const isLast = index === groups.builtInProfiles.length - 1;
                    const isFavorite = groups.favoriteIds.has(profile.id);
                    const isSelected = props.selectedProfileId === profile.id;
                    const isDisabled = props.getProfileDisabled ? props.getProfileDisabled(profile) : false;
                    const baseSubtitle = getProfileSubtitle({ profile, experimentsEnabled: allowGemini, strings });
                    const extra = props.getProfileSubtitleExtra?.(profile);
                    const subtitleText = extra ? `${baseSubtitle} · ${extra}` : baseSubtitle;
                    const showMobileBadge = isMobile && hasRequiredSecret(profile) && Boolean(props.onApiKeyBadgePress);
                    return (
                        <ProfileRow
                            key={profile.id}
                            profile={profile}
                            isSelected={isSelected}
                            isFavorite={isFavorite}
                            isDisabled={isDisabled}
                            showDivider={!isLast}
                            isMobile={isMobile}
                            machineId={props.machineId}
                            experimentsEnabled={props.experimentsEnabled}
                            subtitleText={subtitleText}
                            showMobileBadge={showMobileBadge}
                            onPressProfile={props.onPressProfile}
                            onApiKeyBadgePress={props.onApiKeyBadgePress}
                            rightElement={renderProfileRightElement(profile, isSelected, isFavorite)}
                            ignoreRowPressRef={ignoreRowPressRef}
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

