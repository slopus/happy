import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

interface SessionTypeSelectorProps {
    value: 'simple' | 'worktree';
    onChange: (value: 'simple' | 'worktree') => void;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        borderRadius: 8,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    option: {
        flex: 1,
        paddingVertical: 8,
        alignItems: 'center',
    },
    optionActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    label: {
        fontSize: 14,
    },
    labelActive: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
}));

const SESSION_TYPES = ['simple', 'worktree'] as const;

export const SessionTypeSelector: React.FC<SessionTypeSelectorProps> = ({ value, onChange }) => {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            {SESSION_TYPES.map((type) => {
                const isActive = value === type;
                return (
                    <Pressable
                        key={type}
                        onPress={() => onChange(type)}
                        style={[styles.option, isActive && styles.optionActive]}
                    >
                        <Text style={[styles.label, isActive ? styles.labelActive : styles.labelInactive]}>
                            {t(`newSession.sessionType.${type}`)}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
};
