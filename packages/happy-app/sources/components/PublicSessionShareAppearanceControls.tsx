import * as React from 'react';
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { StyleSheet } from 'react-native-unistyles';
import type { PublicSessionCover, PublicSessionThemePack } from '@slopus/happy-wire';
import { MAX_FILE_SIZE, useImagePicker, type AttachmentPreview } from '@/hooks/useImagePicker';
import { getRandomPublicSessionCover, type PublicSessionCoverCandidate } from '@/sync/apiPublicSessionShares';
import type { PublicSessionCoverSelection } from '@/sync/publicSessionShareQueue';
import { useLocalSettingMutable } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { ACCENTS } from '@/themePacksData';
import { t } from '@/text';

type ExistingCover = PublicSessionCover & { uri: string };

const SUPPORTED_PUBLIC_SESSION_COVER_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
]);

function isSupportedPublicSessionCoverMimeType(
    mimeType: string,
): mimeType is PublicSessionCover['mimeType'] {
    return SUPPORTED_PUBLIC_SESSION_COVER_MIME_TYPES.has(mimeType);
}

export interface PublicSessionShareAppearanceControlsProps {
    sessionId: string;
    themePack: PublicSessionThemePack;
    coverSelection?: PublicSessionCoverSelection;
    existingCover?: ExistingCover;
    disabled?: boolean;
    onThemePackChange: (themePack: PublicSessionThemePack) => void;
    onCoverSelectionChange: (coverSelection: PublicSessionCoverSelection | undefined) => void;
    onReplacementBusyChange: (busy: boolean) => void;
}

export const PublicSessionShareAppearanceControls = React.memo(function PublicSessionShareAppearanceControls({
    sessionId,
    themePack,
    coverSelection,
    existingCover,
    disabled = false,
    onThemePackChange,
    onCoverSelectionChange,
    onReplacementBusyChange,
}: PublicSessionShareAppearanceControlsProps) {
    const [, setLastPublicShareThemePack] = useLocalSettingMutable('lastPublicShareThemePack');
    const { pickImages, clearImages } = useImagePicker({
        maxAttachments: 1,
        maxImageSizeBytes: MAX_FILE_SIZE,
    });
    const [candidate, setCandidate] = React.useState<PublicSessionCoverCandidate | null>(null);
    const [providerUnavailable, setProviderUnavailable] = React.useState(false);
    const [randomLoading, setRandomLoading] = React.useState(false);
    const [uploadPreview, setUploadPreview] = React.useState<AttachmentPreview | null>(null);
    const [uploadLoading, setUploadLoading] = React.useState(false);
    const [uploadFailed, setUploadFailed] = React.useState(false);
    const actionEpoch = React.useRef(0);
    const mountedRef = React.useRef(true);
    const randomLoadingRef = React.useRef(false);
    const replacementBusyRef = React.useRef(false);
    const onReplacementBusyChangeRef = React.useRef(onReplacementBusyChange);
    onReplacementBusyChangeRef.current = onReplacementBusyChange;

    const setReplacementBusy = React.useCallback((busy: boolean) => {
        if (replacementBusyRef.current === busy) return;
        replacementBusyRef.current = busy;
        onReplacementBusyChangeRef.current(busy);
    }, []);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            actionEpoch.current += 1;
            randomLoadingRef.current = false;
            if (replacementBusyRef.current) {
                replacementBusyRef.current = false;
                onReplacementBusyChangeRef.current(false);
            }
        };
    }, []);

    React.useEffect(() => {
        if (!disabled || !replacementBusyRef.current) return;
        actionEpoch.current += 1;
        randomLoadingRef.current = false;
        setRandomLoading(false);
        setUploadLoading(false);
        setReplacementBusy(false);
    }, [disabled, setReplacementBusy]);

    React.useEffect(() => {
        if (coverSelection?.kind !== 'pexels') setCandidate(null);
        if (coverSelection?.kind !== 'upload') setUploadPreview(null);
    }, [coverSelection]);

    const selectThemePack = React.useCallback((nextThemePack: PublicSessionThemePack) => {
        setLastPublicShareThemePack(nextThemePack);
        onThemePackChange(nextThemePack);
    }, [onThemePackChange, setLastPublicShareThemePack]);

    const selectRandomCover = React.useCallback(async () => {
        if (disabled || randomLoadingRef.current) return;
        const credentials = sync.getCredentials();
        if (!credentials) {
            setProviderUnavailable(true);
            return;
        }
        const sequence = actionEpoch.current + 1;
        actionEpoch.current = sequence;
        randomLoadingRef.current = true;
        setReplacementBusy(true);
        setRandomLoading(true);
        setUploadLoading(false);
        setUploadFailed(false);
        setProviderUnavailable(false);
        try {
            const nextCandidate = await getRandomPublicSessionCover(credentials, sessionId);
            if (!mountedRef.current || actionEpoch.current !== sequence) return;
            clearImages();
            setUploadPreview(null);
            setCandidate(nextCandidate);
            onCoverSelectionChange({ kind: 'pexels', photoId: nextCandidate.photoId });
        } catch {
            if (mountedRef.current && actionEpoch.current === sequence) setProviderUnavailable(true);
        } finally {
            if (mountedRef.current && actionEpoch.current === sequence) {
                randomLoadingRef.current = false;
                setRandomLoading(false);
                setReplacementBusy(false);
            }
        }
    }, [clearImages, disabled, onCoverSelectionChange, sessionId, setReplacementBusy]);

    const selectUploadCover = React.useCallback(async () => {
        if (disabled) return;
        const sequence = actionEpoch.current + 1;
        actionEpoch.current = sequence;
        randomLoadingRef.current = false;
        setReplacementBusy(true);
        setRandomLoading(false);
        setUploadLoading(true);
        setUploadFailed(false);
        setProviderUnavailable(false);
        clearImages();
        try {
            const image = (await pickImages())[0];
            if (!mountedRef.current || actionEpoch.current !== sequence || !image) return;
            if (!isSupportedPublicSessionCoverMimeType(image.mimeType)) {
                throw new Error('Unsupported public session cover MIME type');
            }
            setCandidate(null);
            setUploadPreview(image);
            onCoverSelectionChange({
                kind: 'upload',
                attachmentId: randomUUID(),
                uri: image.uri,
                name: image.name,
                mimeType: image.mimeType,
                size: image.size,
                width: image.width,
                height: image.height,
                ...(image.thumbhash ? { thumbhash: image.thumbhash } : {}),
            });
        } catch {
            if (mountedRef.current && actionEpoch.current === sequence) setUploadFailed(true);
        } finally {
            if (mountedRef.current && actionEpoch.current === sequence) {
                setUploadLoading(false);
                setReplacementBusy(false);
            }
        }
    }, [clearImages, disabled, onCoverSelectionChange, pickImages, setReplacementBusy]);

    const removeCover = React.useCallback(() => {
        if (disabled) return;
        actionEpoch.current += 1;
        randomLoadingRef.current = false;
        setRandomLoading(false);
        setUploadLoading(false);
        setUploadFailed(false);
        setReplacementBusy(false);
        clearImages();
        setUploadPreview(null);
        setCandidate(null);
        setProviderUnavailable(false);
        onCoverSelectionChange(undefined);
    }, [clearImages, disabled, onCoverSelectionChange, setReplacementBusy]);

    const selectedUploadUri = uploadPreview?.uri
        ?? (coverSelection?.kind === 'upload' ? coverSelection.uri : undefined);
    const selectedCandidate = candidate;
    const selectedExisting = coverSelection?.kind === 'existing'
        && existingCover?.assetId === coverSelection.assetId
        ? existingCover
        : undefined;
    const previewUri = selectedCandidate?.previewUrl ?? selectedUploadUri ?? selectedExisting?.uri;
    const attribution = selectedCandidate?.attribution ?? selectedExisting?.attribution;
    const hasCover = Boolean(coverSelection || candidate || uploadPreview);

    return (
        <View
            aria-busy={randomLoading || uploadLoading}
            accessibilityLabel={t('sessionShare.appearance')}
            accessibilityState={{ busy: randomLoading || uploadLoading }}
            style={styles.container}
            testID="public-share-appearance-controls"
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('sessionShare.themeColor')}</Text>
                <View accessibilityRole="radiogroup" style={styles.swatchRow}>
                    {ACCENTS.map((accent) => {
                        const selected = accent.id === themePack;
                        return (
                            <Pressable
                                aria-checked={selected}
                                accessibilityLabel={t('sessionShare.themeColorOption', { theme: accent.id })}
                                accessibilityRole="radio"
                                accessibilityState={{ checked: selected, disabled }}
                                disabled={disabled}
                                key={accent.id}
                                onPress={() => selectThemePack(accent.id as PublicSessionThemePack)}
                                style={({ pressed }) => [
                                    styles.swatchButton,
                                    selected && styles.swatchButtonSelected,
                                    pressed && styles.swatchButtonPressed,
                                    disabled && styles.disabled,
                                ]}
                                testID={`public-share-theme-${accent.id}`}
                            >
                                <View style={[styles.swatch, { backgroundColor: accent.swatch.primary }]}>
                                    {selected ? (
                                        <Ionicons color={accent.light.onPrimary} name="checkmark" size={15} />
                                    ) : null}
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('sessionShare.cover')}</Text>
                {previewUri ? (
                    <View style={styles.previewWrap}>
                        <Image
                            accessibilityLabel={t('sessionShare.coverPreview')}
                            resizeMode="cover"
                            source={{ uri: previewUri }}
                            style={styles.preview}
                            testID="public-share-cover-preview"
                        />
                        {attribution ? (
                            <Pressable
                                accessibilityLabel={t('sessionShare.coverAttribution', {
                                    photographer: attribution.photographer,
                                })}
                                accessibilityRole="link"
                                onPress={() => void Linking.openURL(attribution.photoUrl)}
                                style={({ pressed }) => [styles.attributionLink, pressed && styles.attributionLinkPressed]}
                            >
                                <Text style={styles.attributionText} testID="public-share-cover-attribution">
                                    {t('sessionShare.coverAttribution', { photographer: attribution.photographer })}
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>
                ) : (
                    <View accessibilityLabel={t('sessionShare.noCover')} style={styles.emptyCover} testID="public-share-cover-empty">
                        <Ionicons color={styles.emptyCoverIcon.color} name="image-outline" size={20} />
                        <Text style={styles.emptyCoverText}>{t('sessionShare.noCover')}</Text>
                    </View>
                )}
                {providerUnavailable ? (
                    <Text accessibilityRole="alert" style={styles.providerState} testID="public-share-cover-provider-state">
                        {t('sessionShare.coverProviderUnavailable')}
                    </Text>
                ) : null}
                {uploadFailed ? (
                    <Text accessibilityRole="alert" style={styles.providerState} testID="public-share-cover-upload-state">
                        {t('sessionShare.coverUploadFailed')}
                    </Text>
                ) : null}
                {randomLoading || uploadLoading ? (
                    <Text
                        accessibilityLiveRegion="polite"
                        style={styles.replacementState}
                        testID="public-share-cover-replacement-state"
                    >
                        {t('sessionShare.preparing')}
                    </Text>
                ) : null}
                <View style={styles.coverActions}>
                    <CoverAction
                        disabled={disabled || randomLoading}
                        icon="shuffle-outline"
                        label={t('sessionShare.randomCover')}
                        loading={randomLoading}
                        onPress={selectRandomCover}
                        testID="public-share-cover-random"
                    />
                    <CoverAction
                        disabled={disabled}
                        icon="cloud-upload-outline"
                        label={t('sessionShare.uploadCover')}
                        loading={uploadLoading}
                        onPress={selectUploadCover}
                        testID="public-share-cover-upload"
                    />
                    <CoverAction
                        disabled={disabled || !hasCover}
                        icon="trash-outline"
                        label={t('sessionShare.removeCover')}
                        onPress={removeCover}
                        testID="public-share-cover-remove"
                    />
                </View>
            </View>
        </View>
    );
});

function CoverAction({
    disabled,
    icon,
    label,
    loading = false,
    onPress,
    testID,
}: {
    disabled: boolean;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    loading?: boolean;
    onPress: () => void | Promise<void>;
    testID: string;
}) {
    return (
        <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            accessibilityState={{ busy: loading, disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [styles.coverAction, pressed && styles.coverActionPressed, disabled && styles.disabled]}
            testID={testID}
        >
            {loading ? (
                <ActivityIndicator color={styles.coverActionIcon.color} size="small" />
            ) : (
                <Ionicons color={styles.coverActionIcon.color} name={icon} size={16} />
            )}
            <Text numberOfLines={1} style={styles.coverActionText}>{label}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { gap: 16 },
    section: { gap: 10 },
    sectionTitle: { color: theme.colors.text, fontSize: 13, fontWeight: '600' as const },
    swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    swatchButton: {
        width: 38,
        height: 38,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 11,
        backgroundColor: theme.colors.surfaceHigh,
    },
    swatchButtonSelected: { backgroundColor: theme.colors.surfaceSelected },
    swatchButtonPressed: { backgroundColor: theme.colors.surfacePressed },
    swatch: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
    previewWrap: { gap: 7 },
    preview: { width: '100%', aspectRatio: 16 / 7, borderRadius: 11, backgroundColor: theme.colors.surfaceHigh },
    attributionLink: { alignSelf: 'flex-start', borderRadius: 6, paddingVertical: 2, paddingHorizontal: 3 },
    attributionLinkPressed: { backgroundColor: theme.colors.surfacePressed },
    attributionText: { color: theme.colors.textSecondary, fontSize: 11 },
    emptyCover: {
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 11,
        backgroundColor: theme.colors.surfaceHigh,
    },
    emptyCoverIcon: { color: theme.colors.textSecondary },
    emptyCoverText: { color: theme.colors.textSecondary, fontSize: 12 },
    providerState: { color: theme.colors.status.error, fontSize: 12 },
    replacementState: { color: theme.colors.textSecondary, fontSize: 12 },
    coverActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    coverAction: {
        minHeight: 38,
        flexGrow: 1,
        flexBasis: 120,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: 10,
        borderRadius: 9,
        backgroundColor: theme.colors.surfaceHigh,
    },
    coverActionPressed: { backgroundColor: theme.colors.surfacePressed },
    coverActionIcon: { color: theme.colors.accent },
    coverActionText: { color: theme.colors.text, fontSize: 12, fontWeight: '500' as const },
    disabled: { opacity: 0.45 },
}));
