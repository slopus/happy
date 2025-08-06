import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { sessionAllow, sessionDeny } from '@/sync/ops';

interface PermissionActionsProps {
    permission: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
    };
    sessionId: string;
}

export const PermissionActions: React.FC<PermissionActionsProps> = ({ permission, sessionId }) => {
    const [loading, setLoading] = useState(false);

    const handleApprove = async () => {
        if (permission.status !== 'pending' || loading) return;
        
        setLoading(true);
        try {
            await sessionAllow(sessionId, permission.id);
        } catch (error) {
            console.error('Failed to approve permission:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleDeny = async () => {
        if (permission.status !== 'pending' || loading) return;
        
        setLoading(true);
        try {
            await sessionDeny(sessionId, permission.id);
        } catch (error) {
            console.error('Failed to deny permission:', error);
        } finally {
            setLoading(false);
        }
    };

    const isApproved = permission.status === 'approved';
    const isDenied = permission.status === 'denied';
    const isPending = permission.status === 'pending';
    const isCanceled = permission.status === 'canceled';

    return (
        <View style={styles.container}>
            <TouchableOpacity
                style={[
                    styles.button,
                    isApproved && styles.buttonApproved,
                    (!isPending && !isApproved) && styles.buttonDisabled
                ]}
                onPress={handleApprove}
                disabled={!isPending || loading}
                activeOpacity={isPending ? 0.7 : 1}
            >
                {loading && isPending ? (
                    <ActivityIndicator size="small" color={isApproved ? 'white' : '#34C759'} />
                ) : (
                    <Text style={[
                        styles.buttonText,
                        isApproved && styles.buttonTextSelected,
                        (!isPending && !isApproved) && styles.buttonTextDisabled
                    ]}>
                        Allow
                    </Text>
                )}
            </TouchableOpacity>

            <TouchableOpacity
                style={[
                    styles.button,
                    isDenied && styles.buttonDenied,
                    (!isPending && !isDenied) && styles.buttonDisabled
                ]}
                onPress={handleDeny}
                disabled={!isPending || loading}
                activeOpacity={isPending ? 0.7 : 1}
            >
                {loading && isPending ? (
                    <ActivityIndicator size="small" color={isDenied ? 'white' : '#FF3B30'} />
                ) : (
                    <Text style={[
                        styles.buttonText,
                        isDenied && styles.buttonTextSelected,
                        (!isPending && !isDenied) && styles.buttonTextDisabled
                    ]}>
                        Deny
                    </Text>
                )}
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        gap: 8,
        marginLeft: 'auto',
        marginRight: 8,
    },
    button: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#E5E5EA',
        backgroundColor: 'white',
        minWidth: 60,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonApproved: {
        backgroundColor: '#34C759',
        borderColor: '#34C759',
    },
    buttonDenied: {
        backgroundColor: '#FF3B30',
        borderColor: '#FF3B30',
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    buttonText: {
        fontSize: 14,
        fontWeight: '500',
        color: '#007AFF',
    },
    buttonTextSelected: {
        color: 'white',
    },
    buttonTextDisabled: {
        color: '#8E8E93',
    },
});