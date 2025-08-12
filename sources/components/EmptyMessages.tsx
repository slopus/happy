import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { useSessionStatus, formatPathRelativeToHome } from '@/utils/sessionUtils';

interface EmptyMessagesProps {
    session: Session;
}

function getOSIcon(os?: string): keyof typeof Ionicons.glyphMap {
    if (!os) return 'hardware-chip-outline';
    
    const osLower = os.toLowerCase();
    if (osLower.includes('darwin') || osLower.includes('mac')) {
        return 'laptop-outline';
    } else if (osLower.includes('win')) {
        return 'desktop-outline';
    } else if (osLower.includes('linux')) {
        return 'terminal-outline';
    }
    return 'hardware-chip-outline';
}

function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMinutes < 1) {
        return 'just now';
    } else if (diffMinutes < 60) {
        return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
    } else if (diffHours < 24) {
        return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else {
        return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    }
}

export function EmptyMessages({ session }: EmptyMessagesProps) {
    const osIcon = getOSIcon(session.metadata?.os);
    const sessionStatus = useSessionStatus(session);
    const startedTime = formatRelativeTime(session.createdAt);
    
    return (
        <View style={{ 
            flex: 1, 
            justifyContent: 'center', 
            alignItems: 'center',
            paddingHorizontal: 48
        }}>
            <Ionicons 
                name={osIcon}
                size={72} 
                color="#E5E5E7" 
                style={{ marginBottom: 12 }}
            />
            
            {session.metadata?.host && (
                <Text style={{ 
                    fontSize: 18, 
                    color: '#000',
                    textAlign: 'center',
                    marginBottom: 4,
                    ...Typography.default('semiBold')
                }}>
                    {session.metadata.host}
                </Text>
            )}
            
            {session.metadata?.path && (
                <Text style={{ 
                    fontSize: 14, 
                    color: '#8E8E93',
                    textAlign: 'center',
                    marginBottom: 40,
                    ...Typography.default('regular')
                }}>
                    {formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir)}
                </Text>
            )}
            
            <Text style={{ 
                fontSize: 20, 
                color: '#8E8E93',
                textAlign: 'center',
                marginBottom: 8,
                ...Typography.default('regular')
            }}>
                No messages yet
            </Text>
            
            <Text style={{ 
                fontSize: 16, 
                color: '#C7C7CC',
                textAlign: 'center',
                lineHeight: 24,
                ...Typography.default()
            }}>
                Created {startedTime}
            </Text>
        </View>
    );
}