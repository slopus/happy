import React, { useState } from 'react';
import { View, TextInput, ActivityIndicator, Pressable, Text } from 'react-native';
import { Item } from '@/components/Item';
import { Ionicons } from '@expo/vector-icons';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';

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
                    titleStyle={{ 
                        fontFamily: 'Menlo', 
                        fontSize: 14,
                        color: isOnline ? '#000' : '#8E8E93'
                    }}
                    onPress={() => handlePathSelect(path)}
                    disabled={!isOnline}
                    selected={isOnline && customPath === path}
                    showChevron={false}
                />
            ))}
            
            {/* Custom path input with play button OR offline message */}
            {isOnline ? (
                <View style={{ 
                    paddingHorizontal: 16, 
                    paddingVertical: 12,
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    gap: 8
                }}>
                    <TextInput
                        style={{
                            flex: 1,
                            borderWidth: 1,
                            borderColor: '#C7C7CC',
                            borderRadius: 8,
                            padding: 12,
                            fontSize: 14,
                            fontFamily: 'Menlo',
                            backgroundColor: '#F2F2F7',
                            minHeight: 44,
                            textAlignVertical: 'top'
                        }}
                        placeholder="Enter custom path"
                        placeholderTextColor="#8E8E93"
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
                        style={{
                            width: 44,
                            height: 44,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: canStart ? '#007AFF' : '#E5E5EA',
                            borderRadius: 22,
                            opacity: isSpawning ? 0.6 : 1
                        }}
                    >
                        {isSpawning ? (
                            <ActivityIndicator size="small" color="white" />
                        ) : (
                            <Ionicons 
                                name="play" 
                                size={20} 
                                color={canStart ? 'white' : '#8E8E93'}
                                style={{ marginLeft: 2 }} // Slight offset to center visually
                            />
                        )}
                    </Pressable>
                </View>
            ) : (
                <View style={{ 
                    paddingHorizontal: 16, 
                    paddingVertical: 12,
                    alignItems: 'center'
                }}>
                    <Text style={{
                        fontSize: 14,
                        color: '#8E8E93',
                        fontStyle: 'italic'
                    }}>
                        Unable to spawn new session, offline
                    </Text>
                </View>
            )}
        </>
    );
};