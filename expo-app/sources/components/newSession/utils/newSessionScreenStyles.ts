import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const newSessionScreenStyles = StyleSheet.create((theme, rt) => ({
    container: {
        flex: 1,
        justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
        paddingTop: Platform.OS === 'web' ? 20 : 10,
        ...(Platform.select({
            web: { minHeight: 0 },
            default: {},
        }) as any),
    },
    scrollContainer: {
        flex: 1,
        ...(Platform.select({
            web: { minHeight: 0 },
            default: {},
        }) as any),
    },
    contentContainer: {
        width: '100%',
        alignSelf: 'center',
        paddingTop: 0,
        paddingBottom: 16,
    },
    wizardContainer: {
        marginBottom: 16,
    },
    wizardSectionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 6,
        marginTop: 12,
        paddingHorizontal: 16,
    },
    sectionHeader: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
        marginTop: 12,
        ...Typography.default('semiBold')
    },
    sectionDescription: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: Platform.OS === 'web' ? 8 : 0,
        lineHeight: 18,
        paddingHorizontal: 16,
        ...Typography.default()
    },
    profileListItem: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        padding: 8,
        marginBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    profileListItemSelected: {
        borderWidth: 2,
        borderColor: theme.colors.text,
    },
    profileIcon: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.button.primary.background,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 10,
    },
    profileListName: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold')
    },
    profileListDetails: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default()
    },
    addProfileButton: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    addProfileButtonText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.button.secondary.tint,
        marginLeft: 8,
        ...Typography.default('semiBold')
    },
    selectorButton: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        padding: 10,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    selectorButtonText: {
        color: theme.colors.text,
        fontSize: 13,
        flex: 1,
        ...Typography.default()
    },
    permissionGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        marginBottom: 16,
    },
    permissionButton: {
        width: '48%',
        backgroundColor: theme.colors.input.background,
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        alignItems: 'center',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    permissionButtonSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.button.primary.background + '10',
    },
    permissionButtonText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
        marginTop: 8,
        textAlign: 'center',
        ...Typography.default('semiBold')
    },
    permissionButtonTextSelected: {
        color: theme.colors.button.primary.background,
    },
    permissionButtonDesc: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 4,
        textAlign: 'center',
        ...Typography.default()
    },
}));
