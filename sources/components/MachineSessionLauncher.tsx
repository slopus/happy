import React, { useState } from 'react';
import { View, TextInput, ActivityIndicator, Pressable, Text } from 'react-native';
import { Item } from '@/components/Item';
import { Ionicons } from '@expo/vector-icons';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    pathInput: {
        flex: 1,
        borderRadius: 8,
        padding: 12,
        fontSize: 14,
        fontFamily: 'Menlo',
        backgroundColor: theme.colors.groupped.background,
        minHeight: 44,
        textAlignVertical: 'top',
        color: theme.colors.text,
    },
    pathItemTitle: {
        fontFamily: 'Menlo',
        fontSize: 14,
    },
    pathItemTitleEnabled: {
        color: theme.colors.text,
    },
    pathItemTitleDisabled: {
        color: theme.colors.textSecondary,
    },
    playButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 22,
    },
    playButtonEnabled: {
        backgroundColor: theme.colors.button.primary.background,
    },
    playButtonDisabled: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    playButtonSpawning: {
        opacity: 0.6,
    },
    playIcon: {
        marginLeft: 2, // Slight offset to center visually
    },
    playIconEnabled: {
        color: theme.colors.button.primary.tint,
    },
    playIconDisabled: {
        color: theme.colors.textSecondary,
    },
    offlineContainer: {
        alignItems: 'center',
    },
    offlineText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
}));

interface MachineSessionLauncherProps {
    machineId: string;
    recentPaths: string[];
    homeDir?: string;
    isOnline: boolean;
    onStartSession: (path: string) => Promise<void>;
}

export const MachineSessionLauncher: React.FC<MachineSessionLauncherProps> = ({
    machineId,
    recentPaths,
    homeDir,
    isOnline,
    onStartSession
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [customPath, setCustomPath] = useState('');
    const [isSpawning, setIsSpawning] = useState(false);

    const handlePathSelect = (path: string) => {
        setCustomPath(path);
    };

    const handleStartSession = async () => {
        const pathToUse = customPath.trim() || '~';
        if (isSpawning || !isOnline) return;
        
        setIsSpawning(true);
        try {
            await onStartSession(pathToUse);
        } finally {
            setIsSpawning(false);
        }
    };

    const canStart = isOnline && customPath.trim() !== '';

    return (
        <>
            {/* Show recent paths - click to populate input */}
            {recentPaths.slice(0, 3).map(path => (
                <Item
                    key={path}
                    title={formatPathRelativeToHome(path, homeDir)}
                    titleStyle={[
                        styles.pathItemTitle,
                        isOnline ? styles.pathItemTitleEnabled : styles.pathItemTitleDisabled
                    ]}
                    onPress={() => handlePathSelect(path)}
                    disabled={!isOnline}
                    selected={isOnline && customPath === path}
                    showChevron={false}
                />
            ))}
            
            {/* Custom path input with play button OR offline message */}
            {isOnline ? (
                <View style={[styles.container, styles.inputContainer]}>
                    <TextInput
                        style={styles.pathInput}
                        placeholder="Enter custom path"
                        placeholderTextColor={theme.colors.textSecondary}
                        value={customPath}
                        onChangeText={setCustomPath}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline={true}
                        editable={!isSpawning}
                    />
                    <Pressable
                        onPress={handleStartSession}
                        disabled={!canStart || isSpawning}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={[
                            styles.playButton,
                            canStart ? styles.playButtonEnabled : styles.playButtonDisabled,
                            isSpawning && styles.playButtonSpawning
                        ]}
                    >
                        {isSpawning ? (
                            <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                        ) : (
                            <Ionicons 
                                name="play" 
                                size={20} 
                                style={[
                                    styles.playIcon,
                                    canStart ? styles.playIconEnabled : styles.playIconDisabled
                                ]}
                            />
                        )}
                    </Pressable>
                </View>
            ) : (
                <View style={[styles.container, styles.offlineContainer]}>
                    <Text style={styles.offlineText}>
                        Unable to spawn new session, offline
                    </Text>
                </View>
            )}
        </>
    );
};