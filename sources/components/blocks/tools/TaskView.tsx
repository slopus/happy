import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../ToolSectionView';
import { knownTools } from '../knownTools';
import { Ionicons } from '@expo/vector-icons';

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata }) => {
    const childTools = tool.children || [];
    const maxToolsToShow = 3;
    const toolsToShow = childTools.slice(0, maxToolsToShow);
    const remainingCount = childTools.length - maxToolsToShow;
    if (childTools.length === 0) {
        return null;
    }

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {toolsToShow.map((childTool, index) => {
                    const knownTool = knownTools[childTool.name as keyof typeof knownTools] as any;
                    const icon = knownTool?.icon || 'construct';
                    const title = knownTool?.title || childTool.name;
                    
                    let subtitle = childTool.description;
                    if (knownTool && typeof knownTool.extractSubtitle === 'function') {
                        const extractedSubtitle = knownTool.extractSubtitle({ tool: childTool, metadata });
                        if (extractedSubtitle) {
                            subtitle = extractedSubtitle;
                        }
                    }

                    return (
                        <View key={index}>
                            <View style={styles.toolItem}>
                                <Ionicons 
                                    name={icon as any} 
                                    size={16} 
                                    color="#8E8E93" 
                                />
                                <Text style={styles.toolTitle}>{title}</Text>
                                {subtitle && (
                                    <>
                                        <Text style={styles.separator}>·</Text>
                                        <Text style={styles.toolSubtitle} numberOfLines={1}>
                                            {subtitle}
                                        </Text>
                                    </>
                                )}
                            </View>
                            {index < toolsToShow.length - 1 && <View style={styles.divider} />}
                        </View>
                    );
                })}
                
                {remainingCount > 0 && (
                    <View style={styles.moreContainer}>
                        <Text style={styles.moreText}>+{remainingCount} more tool{remainingCount > 1 ? 's' : ''}</Text>
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create({
    container: {
        paddingVertical: 4,
    },
    toolItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6,
        paddingHorizontal: 12,
        gap: 8,
    },
    toolTitle: {
        fontSize: 14,
        fontWeight: '500',
        color: '#000',
    },
    separator: {
        fontSize: 14,
        color: '#C7C7CC',
        marginHorizontal: 4,
    },
    toolSubtitle: {
        fontSize: 14,
        color: '#8E8E93',
        flex: 1,
    },
    divider: {
        height: 1,
        backgroundColor: '#F2F2F7',
        marginHorizontal: 12,
    },
    moreContainer: {
        paddingTop: 8,
        paddingHorizontal: 12,
    },
    moreText: {
        fontSize: 13,
        color: '#8E8E93',
        fontStyle: 'italic',
    },
});