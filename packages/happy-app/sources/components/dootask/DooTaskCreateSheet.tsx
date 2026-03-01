import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type Props = {
    onSelectTask: () => void;
    onSelectProject: () => void;
};

export const DooTaskCreateSheet = React.memo(React.forwardRef<BottomSheetModal, Props>(
    ({ onSelectTask, onSelectProject }, ref) => {
        const { theme } = useUnistyles();

        const renderBackdrop = React.useCallback(
            (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
            [],
        );

        const handleTask = React.useCallback(() => {
            (ref as React.RefObject<BottomSheetModal>).current?.dismiss();
            setTimeout(onSelectTask, 300);
        }, [ref, onSelectTask]);

        const handleProject = React.useCallback(() => {
            (ref as React.RefObject<BottomSheetModal>).current?.dismiss();
            setTimeout(onSelectProject, 300);
        }, [ref, onSelectProject]);

        return (
            <BottomSheetModal
                ref={ref}
                enableDynamicSizing={true}
                backdropComponent={renderBackdrop}
                backgroundStyle={{ backgroundColor: theme.colors.surface }}
                handleIndicatorStyle={{ backgroundColor: theme.colors.textSecondary }}
            >
                <View style={styles.container}>
                    <Pressable style={[styles.option, { borderBottomColor: theme.colors.divider, borderBottomWidth: StyleSheet.hairlineWidth }]} onPress={handleTask}>
                        <Ionicons name="checkbox-outline" size={22} color={theme.colors.text} />
                        <Text style={[styles.optionText, { color: theme.colors.text }]}>{t('dootask.addTask')}</Text>
                    </Pressable>
                    <Pressable style={styles.option} onPress={handleProject}>
                        <Ionicons name="folder-outline" size={22} color={theme.colors.text} />
                        <Text style={[styles.optionText, { color: theme.colors.text }]}>{t('dootask.addProject')}</Text>
                    </Pressable>
                </View>
            </BottomSheetModal>
        );
    }
));

const styles = StyleSheet.create((_theme) => ({
    container: {
        paddingHorizontal: 16,
        paddingBottom: 32,
    },
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 16,
        gap: 12,
    },
    optionText: {
        ...Typography.default('semiBold'),
        fontSize: 16,
    },
}));
