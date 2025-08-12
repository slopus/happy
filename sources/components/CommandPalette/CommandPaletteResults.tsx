import React, { useRef, useEffect } from 'react';
import { View, ScrollView, Text, StyleSheet, Platform } from 'react-native';
import { Command, CommandCategory } from './types';
import { CommandPaletteItem } from './CommandPaletteItem';
import { Typography } from '@/constants/Typography';

interface CommandPaletteResultsProps {
    categories: CommandCategory[];
    selectedIndex: number;
    onSelectCommand: (command: Command) => void;
    onSelectionChange: (index: number) => void;
}

export function CommandPaletteResults({ 
    categories, 
    selectedIndex, 
    onSelectCommand, 
    onSelectionChange 
}: CommandPaletteResultsProps) {
    const scrollViewRef = useRef<ScrollView>(null);
    const itemRefs = useRef<{ [key: number]: View | null }>({});
    
    // Flatten commands for index tracking
    const allCommands = React.useMemo(() => {
        return categories.flatMap(cat => cat.commands);
    }, [categories]);

    // Scroll to selected item when index changes
    useEffect(() => {
        const selectedItem = itemRefs.current[selectedIndex];
        if (selectedItem && scrollViewRef.current) {
            // For web, we need to use the DOM API
            if (typeof (selectedItem as any).scrollIntoView === 'function') {
                (selectedItem as any).scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest',
                });
            }
        }
    }, [selectedIndex]);

    if (categories.length === 0 || allCommands.length === 0) {
        return (
            <View style={styles.emptyContainer}>
                <Text style={[styles.emptyText, Typography.default()]}>
                    No commands found
                </Text>
            </View>
        );
    }

    let currentIndex = 0;

    return (
        <ScrollView 
            ref={scrollViewRef}
            style={styles.container}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
        >
            {categories.map(category => {
                if (category.commands.length === 0) return null;
                
                const categoryStartIndex = currentIndex;
                const categoryCommands = category.commands.map((command, idx) => {
                    const commandIndex = categoryStartIndex + idx;
                    const isSelected = commandIndex === selectedIndex;
                    currentIndex++;
                    
                    return (
                        <View
                            key={command.id}
                            ref={(ref) => {
                                itemRefs.current[commandIndex] = ref;
                            }}
                        >
                            <CommandPaletteItem
                                command={command}
                                isSelected={isSelected}
                                onPress={() => onSelectCommand(command)}
                                onHover={() => onSelectionChange(commandIndex)}
                            />
                        </View>
                    );
                });

                return (
                    <View key={category.id}>
                        <Text style={[styles.categoryTitle, Typography.default('semiBold')]}>
                            {category.title}
                        </Text>
                        {categoryCommands}
                    </View>
                );
            })}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        // Use viewport-based height for better proportions
        ...(Platform.OS === 'web' ? {
            maxHeight: '40vh', // 40% of viewport height for results
        } as any : {
            maxHeight: 420, // Fallback for native
        }),
        paddingVertical: 8,
    },
    emptyContainer: {
        padding: 48,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 15,
        color: '#999',
        letterSpacing: -0.2,
    },
    categoryTitle: {
        paddingHorizontal: 32,
        paddingTop: 16,
        paddingBottom: 8,
        fontSize: 12,
        color: '#999',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        fontWeight: '600',
    },
});