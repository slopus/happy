import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

export interface SessionTypeSelectorProps {
    value: 'simple' | 'worktree';
    onChange: (value: 'simple' | 'worktree') => void;
    title?: string | null;
}

const stylesheet = StyleSheet.create((theme) => ({
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioActive: {
        borderColor: theme.colors.radio.active,
    },
    radioInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.radio.dot,
    },
}));

export function SessionTypeSelectorRows({ value, onChange }: Pick<SessionTypeSelectorProps, 'value' | 'onChange'>) {
    const styles = stylesheet;

    return (
        <>
            <Item
                title={t('newSession.sessionType.simple')}
                leftElement={(
                    <View style={[styles.radioOuter, value === 'simple' ? styles.radioActive : styles.radioInactive]}>
                        {value === 'simple' && <View style={styles.radioDot} />}
                    </View>
                )}
                selected={value === 'simple'}
                onPress={() => onChange('simple')}
                showChevron={false}
                showDivider={true}
            />

            <Item
                title={t('newSession.sessionType.worktree')}
                leftElement={(
                    <View style={[styles.radioOuter, value === 'worktree' ? styles.radioActive : styles.radioInactive]}>
                        {value === 'worktree' && <View style={styles.radioDot} />}
                    </View>
                )}
                selected={value === 'worktree'}
                onPress={() => onChange('worktree')}
                showChevron={false}
                showDivider={false}
            />
        </>
    );
}

export function SessionTypeSelector({ value, onChange, title = t('newSession.sessionType.title') }: SessionTypeSelectorProps) {
    if (title === null) {
        return <SessionTypeSelectorRows value={value} onChange={onChange} />;
    }

    return (
        <ItemGroup title={title}>
            <SessionTypeSelectorRows value={value} onChange={onChange} />
        </ItemGroup>
    );
}
