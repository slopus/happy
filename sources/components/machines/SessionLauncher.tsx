import React, { useState } from 'react';
import { View, Text, TextInput, ActivityIndicator, Pressable } from 'react-native';
import { RoundButton } from '@/components/RoundButton';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';

interface SessionLauncherProps {
    machineId: string;
    recentPaths: string[];
    onSessionStart: (path: string) => Promise<void>;
    disabled?: boolean;
    homeDir?: string;
}

export const SessionLauncher = React.memo(({ 
    machineId,
    recentPaths, 
    onSessionStart,
    disabled = false,
    homeDir = '~'
}: SessionLauncherProps) => {
    const [customPath, setCustomPath] = useState('');
    const [isSpawning, setIsSpawning] = useState(false);
    
    const handleStartSession = async (path: string) => {
        if (isSpawning || disabled) return;
        
        setIsSpawning(true);
        try {
            await onSessionStart(path);
        } finally {
            setIsSpawning(false);
        }
    };
    
    const handlePathClick = (path: string) => {
        setCustomPath(path);
    };
    
    return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            {recentPaths.length > 0 && (
                <View style={{ marginBottom: 12 }}>
                    <Text style={[Typography.default(), { 
                        fontSize: 13, 
                        color: '#8E8E93',
                        marginBottom: 8
                    }]}>
                        Recent Paths:
                    </Text>
                    {recentPaths.slice(0, 3).map(path => (
                        <Pressable
                            key={path}
                            onPress={() => handlePathClick(path)}
                            disabled={disabled}
                            style={{ 
                                paddingVertical: 6,
                                opacity: disabled ? 0.5 : 1
                            }}
                        >
                            <Text style={{
                                fontFamily: 'Menlo',
                                fontSize: 14,
                                color: disabled ? '#8E8E93' : '#007AFF'
                            }}>
                                • {formatPathRelativeToHome(path, homeDir)}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            )}
            
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <TextInput
                    style={{
                        flex: 1,
                        borderWidth: 1,
                        borderColor: disabled ? '#E5E5EA' : '#C7C7CC',
                        borderRadius: 8,
                        padding: 12,
                        fontSize: 14,
                        fontFamily: 'Menlo',
                        backgroundColor: disabled ? '#F9F9F9' : '#FFF',
                        minHeight: 44,
                        textAlignVertical: 'top',
                        opacity: disabled ? 0.5 : 1
                    }}
                    placeholder="Enter path (default: ~)"
                    placeholderTextColor="#8E8E93"
                    value={customPath}
                    onChangeText={setCustomPath}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline={true}
                    editable={!disabled && !isSpawning}
                />
                <RoundButton
                    size="normal"
                    onPress={() => handleStartSession(customPath || '~')}
                    disabled={disabled || isSpawning || !customPath.trim()}
                    style={{ 
                        marginLeft: 8,
                        backgroundColor: !disabled && !isSpawning && customPath.trim() ? '#007AFF' : '#C7C7CC'
                    }}
                    title={
                        isSpawning ? (
                            <ActivityIndicator size="small" color="white" />
                        ) : (
                            <Ionicons name="play" size={20} color="white" />
                        )
                    }
                />
            </View>
        </View>
    );
});

SessionLauncher.displayName = 'SessionLauncher';