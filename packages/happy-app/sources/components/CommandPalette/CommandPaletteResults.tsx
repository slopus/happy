import React, { useRef, useEffect } from 'react';
import { View, ScrollView, Text, Platform } from 'react-native';
import { COMMAND_PALETTE_RESULTS_ID, Command, CommandCategory } from './types';
import { CommandPaletteItem } from './CommandPaletteItem';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';

interface CommandPaletteResultsProps {
    categories: CommandCategory[];
    searchQuery: string;
    selectedIndex: number;
    onSelectCommand: (command: Command) => void;
    onSelectionChange: (index: number) => void;
}

export function CommandPaletteResults({ 
    categories, 
    searchQuery,
    selectedIndex, 
    onSelectCommand, 
    onSelectionChange 
}: CommandPaletteResultsProps) {
    const styles = stylesheet;
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
                <Text style={styles.emptyText}>
                    {t('commandPalette.noCommandsFound')}
                </Text>
            </View>
        );
    }

    let currentIndex = 0;

    return (
        <ScrollView 
            ref={scrollViewRef}
            nativeID={COMMAND_PALETTE_RESULTS_ID}
            {...(Platform.OS === 'web' ? { role: 'listbox' } as any : {})}
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
                                searchQuery={searchQuery}
                                quickSelectNumber={commandIndex < 9 ? commandIndex + 1 : undefined}
                                isSelected={isSelected}
                                onPress={() => onSelectCommand(command)}
                                onHover={() => onSelectionChange(commandIndex)}
                            />
                        </View>
                    );
                });

                return (
                    <View key={category.id}>
                        <Text
                            style={styles.categoryTitle}
                        >
                            {category.title}
                        </Text>
                        {categoryCommands}
                    </View>
                );
            })}
        </ScrollView>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        ...(Platform.OS === 'web' ? {
            maxHeight: '48vh',
        } as any : {
            maxHeight: 420,
        }),
        paddingVertical: 7,
    },
    emptyContainer: {
        paddingHorizontal: 24,
        paddingVertical: 40,
        alignItems: 'center',
    },
    emptyText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    categoryTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 6,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        fontWeight: '600',
    },
}));
