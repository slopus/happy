import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { getSessionState } from '@/utils/sessionUtils';

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
    const sessionStatus = getSessionState(session);
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
            
            <View style={{ 
                flexDirection: 'row', 
                alignItems: 'center',
                backgroundColor: sessionStatus.isConnected ? '#F2F7F2' : '#F2F2F7',
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 16,
                marginBottom: 40
            }}>
                <View style={{ 
                    width: 8, 
                    height: 8, 
                    borderRadius: 4, 
                    backgroundColor: sessionStatus.statusDotColor,
                    marginRight: 8
                }} />
                <Text style={{ 
                    fontSize: 14, 
                    color: sessionStatus.statusColor,
                    ...Typography.default('regular')
                }}>
                    {sessionStatus.statusText || 'connected'}
                </Text>
            </View>
            
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