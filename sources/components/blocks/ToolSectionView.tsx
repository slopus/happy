import * as React from 'react';
import { Text, View, StyleSheet } from 'react-native';

interface ToolSectionViewProps {
    title?: string;
    children: React.ReactNode;
}

export const ToolSectionView = React.memo<ToolSectionViewProps>(({ title, children }) => {
    return (
        <View style={styles.section}>
            {title && <Text style={styles.sectionTitle}>{title}</Text>}
            {children}
        </View>
    );
});

const styles = StyleSheet.create({
    section: {
        marginBottom: 12,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: '#666',
        marginBottom: 6,
        textTransform: 'uppercase',
    },
});