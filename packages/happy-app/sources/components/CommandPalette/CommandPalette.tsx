import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { CommandPaletteInput } from './CommandPaletteInput';
import { CommandPaletteResults } from './CommandPaletteResults';
import { useCommandPalette } from './useCommandPalette';
import { Command, CommandPaletteClose, getCommandPaletteOptionId } from './types';
import { useUnistyles } from 'react-native-unistyles';

interface CommandPaletteProps {
    commands: Command[];
    onClose: CommandPaletteClose;
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
    const { theme } = useUnistyles();
    const {
        searchQuery,
        selectedIndex,
        filteredCategories,
        inputRef,
        handleSearchChange,
        handleSelectCommand,
        handleKeyPress,
        setSelectedIndex,
    } = useCommandPalette(commands, onClose);
    const activeCommand = filteredCategories.flatMap((category) => category.commands)[selectedIndex];
    const activeDescendantId = activeCommand ? getCommandPaletteOptionId(activeCommand.id) : undefined;

    // Only render on web
    if (Platform.OS !== 'web') {
        return null;
    }

    return (
        <View
            testID="command-palette"
            style={[
                styles.container,
                {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.divider,
                    ...(Platform.OS === 'web' ? {
                        boxShadow: `0 12px 32px ${theme.colors.shadow.color}`,
                    } as any : {}),
                },
            ]}
        >
            <CommandPaletteInput
                value={searchQuery}
                onChangeText={handleSearchChange}
                onKeyPress={handleKeyPress}
                inputRef={inputRef}
                activeDescendantId={activeDescendantId}
            />
            <CommandPaletteResults
                categories={filteredCategories}
                searchQuery={searchQuery}
                selectedIndex={selectedIndex}
                onSelectCommand={handleSelectCommand}
                onSelectionChange={setSelectedIndex}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderRadius: 14,
        width: '100%',
        maxWidth: 720,
        ...(Platform.OS === 'web' ? {
            maxHeight: '64vh',
        } as any : {
            maxHeight: 500,
        }),
        overflow: 'hidden',
        ...Platform.select({
            web: {},
            default: {
                shadowOffset: {
                    width: 0,
                    height: 8,
                },
                shadowRadius: 18,
                elevation: 10,
            },
        }),
        borderWidth: StyleSheet.hairlineWidth,
    },
});
