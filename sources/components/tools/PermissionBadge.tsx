import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface PermissionBadgeProps {
    permission: {
        status: 'pending' | 'approved' | 'denied' | 'canceled';
        reason?: string;
    };
}

export const PermissionBadge: React.FC<PermissionBadgeProps> = ({ permission }) => {
    const getStatusStyle = () => {
        switch (permission.status) {
            case 'pending':
                return styles.pending;
            case 'approved':
                return styles.approved;
            case 'denied':
                return styles.denied;
            case 'canceled':
                return styles.canceled;
        }
    };

    const getStatusText = () => {
        return permission.status.toUpperCase();
    };

    return (
        <View style={[styles.badge, getStatusStyle()]}>
            <Text style={styles.text}>{getStatusText()}</Text>
        </View>
    );
};

const styles = StyleSheet.create({
    badge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        marginRight: 8,
    },
    text: {
        color: 'white',
        fontSize: 10,
        fontWeight: '600',
        letterSpacing: 0.5,
    },
    pending: {
        backgroundColor: '#FF9500',
    },
    approved: {
        backgroundColor: '#34C759',
    },
    denied: {
        backgroundColor: '#FF3B30',
    },
    canceled: {
        backgroundColor: '#8E8E93',
    },
});