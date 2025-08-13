import React from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    ScrollView,
    Platform
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { hapticsLight } from './haptics';
import { PermissionMode } from './PermissionModeSelector';

interface ChatSettingsModalProps {
    currentMode: PermissionMode;
    onModeChange: (mode: PermissionMode) => void;
    onClose: () => void;
}

const modeConfig = {
    default: {
        label: 'Default',
        icon: 'shield-checkmark' as const,
        description: 'Ask for permissions before making changes'
    },
    acceptEdits: {
        label: 'Accept Edits',
        icon: 'create' as const,
        description: 'Auto-approve all file edits'
    },
    plan: {
        label: 'Plan Mode',
        icon: 'list' as const,
        description: 'Plan tasks before executing them'
    },
    bypassPermissions: {
        label: 'Yolo Mode',
        icon: 'flash' as const,
        description: 'Skip all permission checks'
    },
};

export function ChatSettingsModal({ currentMode, onModeChange, onClose }: ChatSettingsModalProps) {
    const handleModeSelect = (mode: PermissionMode) => {
        hapticsLight();
        onModeChange(mode);
        onClose();
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>Chat Settings</Text>
                <Pressable
                    onPress={onClose}
                    style={styles.closeButton}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                    <Ionicons name="close" size={24} color="#666" />
                </Pressable>
            </View>

            <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                <Text style={styles.sectionTitle}>Permission Mode</Text>
                <Text style={styles.sectionDescription}>
                    Choose how Happy handles permissions for this chat
                </Text>

                <View style={styles.modeList}>
                    {(Object.keys(modeConfig) as PermissionMode[]).map((mode) => {
                        const config = modeConfig[mode];
                        const isSelected = currentMode === mode;

                        return (
                            <Pressable
                                key={mode}
                                onPress={() => handleModeSelect(mode)}
                                style={[
                                    styles.modeItem,
                                    isSelected && styles.modeItemSelected
                                ]}
                            >
                                <View style={styles.modeItemContent}>
                                    <View style={styles.modeItemLeft}>
                                        <View style={[
                                            styles.radioOuter,
                                            isSelected && styles.radioOuterSelected
                                        ]}>
                                            {isSelected && <View style={styles.radioInner} />}
                                        </View>
                                        <Ionicons
                                            name={config.icon}
                                            size={20}
                                            color={isSelected ? '#007AFF' : '#666'}
                                            style={styles.modeIcon}
                                        />
                                        <View style={styles.modeTextContainer}>
                                            <Text style={[
                                                styles.modeLabel,
                                                isSelected && styles.modeLabelSelected
                                            ]}>
                                                {config.label}
                                            </Text>
                                            <Text style={styles.modeDescription}>
                                                {config.description}
                                            </Text>
                                        </View>
                                    </View>
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: 'white',
        borderRadius: 16,
        width: '90%',
        maxWidth: 400,
        maxHeight: '80%',
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#E5E5E5',
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        color: '#000',
        ...Typography.default('semiBold'),
    },
    closeButton: {
        padding: 4,
    },
    content: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 20,
    },
    sectionTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: '#000',
        marginBottom: 4,
        ...Typography.default('semiBold'),
    },
    sectionDescription: {
        fontSize: 13,
        color: '#666',
        marginBottom: 16,
        ...Typography.default(),
    },
    modeList: {
        gap: 8,
    },
    modeItem: {
        backgroundColor: '#F8F8F8',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    modeItemSelected: {
        backgroundColor: '#F0F8FF',
        borderColor: '#007AFF',
    },
    modeItemContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    modeItemLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: '#C0C0C0',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    radioOuterSelected: {
        borderColor: '#007AFF',
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: '#007AFF',
    },
    modeIcon: {
        marginRight: 12,
    },
    modeTextContainer: {
        flex: 1,
    },
    modeLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: '#000',
        marginBottom: 2,
        ...Typography.default('semiBold'),
    },
    modeLabelSelected: {
        color: '#007AFF',
    },
    modeDescription: {
        fontSize: 12,
        color: '#666',
        ...Typography.default(),
    },
});