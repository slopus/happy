import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

interface ToolSectionViewProps {
    title?: string;
    fullWidth?: boolean;
    children: React.ReactNode;
}

export const ToolSectionView = React.memo<ToolSectionViewProps>(({ title, children, fullWidth }) => {
    return (
        <View style={[styles.section, fullWidth && styles.fullWidthSection]}>
            {title && <Text style={styles.sectionTitle}>{title}</Text>}
            <View style={fullWidth ? styles.fullWidthContent : undefined}>
                {children}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    section: {
        marginBottom: 12,
        overflow: 'visible',
    },
    fullWidthSection: {
        marginHorizontal: -12, // Compensate for parent padding
    },
    fullWidthContent: {
        // No negative margins needed since we're moving the whole section
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.toolDescriptionText,
        marginBottom: 6,
        marginHorizontal: 12, // Add padding back for title when full width
        textTransform: 'uppercase',
    },
}));