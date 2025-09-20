import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';

import { useAuth } from '@/auth/AuthContext';
import {
    verifyPassword,
    storePasswordHash,
    validatePassword,
    DEFAULT_PASSWORD_RULES,
    PasswordStrength
} from '@/auth/passwordSecurity';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Password change screen for updating existing password
 */
export default function PasswordChangeScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const { checkPasswordProtection } = useAuth();

    const [currentPassword, setCurrentPassword] = React.useState('');
    const [newPassword, setNewPassword] = React.useState('');
    const [confirmPassword, setConfirmPassword] = React.useState('');
    const [showCurrentPassword, setShowCurrentPassword] = React.useState(false);
    const [showNewPassword, setShowNewPassword] = React.useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = React.useState(false);
    const [isLoading, setIsLoading] = React.useState(false);
    const [passwordStrength, setPasswordStrength] = React.useState<PasswordStrength | null>(null);

    // Validate password strength as user types
    React.useEffect(() => {
        if (newPassword.length > 0) {
            const strength = validatePassword(newPassword, DEFAULT_PASSWORD_RULES);
            setPasswordStrength(strength);
        } else {
            setPasswordStrength(null);
        }
    }, [newPassword]);

    const handleChangePassword = async () => {
        // Validation
        if (!currentPassword.trim()) {
            Modal.alert(t('password.error'), t('password.currentPassword'));
            return;
        }

        if (!newPassword.trim()) {
            Modal.alert(t('password.error'), t('password.enterPassword'));
            return;
        }

        if (!passwordStrength?.isValid) {
            Modal.alert(t('password.error'), passwordStrength?.feedback.join('\n') || t('password.passwordTooWeak'));
            return;
        }

        if (newPassword !== confirmPassword) {
            Modal.alert(t('password.error'), t('password.passwordMismatch'));
            return;
        }

        if (currentPassword === newPassword) {
            Modal.alert(t('password.error'), 'New password must be different from current password');
            return;
        }

        setIsLoading(true);
        try {
            // Verify current password
            const isCurrentValid = await verifyPassword(currentPassword);
            if (!isCurrentValid) {
                Modal.alert(t('password.error'), t('password.incorrectPassword'));
                return;
            }

            // Store the new password hash
            await storePasswordHash(newPassword);

            // Refresh auth context
            await checkPasswordProtection();

            Modal.alert(t('common.success'), t('password.passwordChanged'));
            router.back();
        } catch (error) {
            console.error('Failed to change password:', error);
            Modal.alert(t('password.error'), t('errors.operationFailed'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleCancel = () => {
        router.back();
    };

    const getStrengthColor = () => {
        if (!passwordStrength) return theme.colors.textSecondary;

        switch (passwordStrength.score) {
            case 0:
            case 1:
                return '#FF3B30'; // Red
            case 2:
                return '#FF9500'; // Orange
            case 3:
                return '#FFCC00'; // Yellow
            case 4:
                return '#34C759'; // Green
            default:
                return theme.colors.textSecondary;
        }
    };

    const getStrengthText = () => {
        if (!passwordStrength) return '';

        switch (passwordStrength.score) {
            case 0:
            case 1:
                return t('password.passwordStrengthWeak');
            case 2:
                return t('password.passwordStrengthMedium');
            case 3:
            case 4:
                return t('password.passwordStrengthStrong');
            default:
                return '';
        }
    };

    return (
        <ScrollView style={[styles.container, { paddingTop: safeArea.top }]} contentContainerStyle={styles.content}>
            {/* Header */}
            <View style={styles.header}>
                <Ionicons
                    name="key-outline"
                    size={64}
                    color={theme.colors.text}
                />
                <Text style={[styles.title, { color: theme.colors.text }]}>
                    {t('password.changePassword')}
                </Text>
                <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
                    Enter your current password and choose a new one
                </Text>
            </View>

            {/* Form */}
            <View style={styles.form}>
                {/* Current Password Input */}
                <View style={styles.inputGroup}>
                    <Text style={[styles.label, { color: theme.colors.text }]}>
                        {t('password.currentPassword')}
                    </Text>
                    <View style={[styles.inputContainer, { borderColor: theme.colors.divider }]}>
                        <TextInput
                            style={[styles.input, { color: theme.colors.text }]}
                            value={currentPassword}
                            onChangeText={setCurrentPassword}
                            placeholder={t('password.currentPassword')}
                            placeholderTextColor={theme.colors.textSecondary}
                            secureTextEntry={!showCurrentPassword}
                            autoComplete="current-password"
                            textContentType="password"
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <Pressable
                            onPress={() => setShowCurrentPassword(!showCurrentPassword)}
                            style={styles.toggleButton}
                        >
                            <Ionicons
                                name={showCurrentPassword ? 'eye-off-outline' : 'eye-outline'}
                                size={20}
                                color={theme.colors.textSecondary}
                            />
                        </Pressable>
                    </View>
                </View>

                {/* New Password Input */}
                <View style={styles.inputGroup}>
                    <Text style={[styles.label, { color: theme.colors.text }]}>
                        {t('password.newPassword')}
                    </Text>
                    <View style={[styles.inputContainer, { borderColor: theme.colors.divider }]}>
                        <TextInput
                            style={[styles.input, { color: theme.colors.text }]}
                            value={newPassword}
                            onChangeText={setNewPassword}
                            placeholder={t('password.newPassword')}
                            placeholderTextColor={theme.colors.textSecondary}
                            secureTextEntry={!showNewPassword}
                            autoComplete="new-password"
                            textContentType="newPassword"
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <Pressable
                            onPress={() => setShowNewPassword(!showNewPassword)}
                            style={styles.toggleButton}
                        >
                            <Ionicons
                                name={showNewPassword ? 'eye-off-outline' : 'eye-outline'}
                                size={20}
                                color={theme.colors.textSecondary}
                            />
                        </Pressable>
                    </View>

                    {/* Password Strength Indicator */}
                    {passwordStrength && (
                        <View style={styles.strengthContainer}>
                            <View style={styles.strengthBar}>
                                <View
                                    style={[
                                        styles.strengthFill,
                                        {
                                            width: `${(passwordStrength.score / 4) * 100}%`,
                                            backgroundColor: getStrengthColor(),
                                        },
                                    ]}
                                />
                            </View>
                            <Text style={[styles.strengthText, { color: getStrengthColor() }]}>
                                {getStrengthText()}
                            </Text>
                        </View>
                    )}

                    {/* Password Feedback */}
                    {passwordStrength && passwordStrength.feedback.length > 0 && (
                        <View style={styles.feedbackContainer}>
                            {passwordStrength.feedback.map((feedback, index) => (
                                <Text key={index} style={[styles.feedbackText, { color: theme.colors.textSecondary }]}>
                                    • {feedback}
                                </Text>
                            ))}
                        </View>
                    )}
                </View>

                {/* Confirm Password Input */}
                <View style={styles.inputGroup}>
                    <Text style={[styles.label, { color: theme.colors.text }]}>
                        {t('password.confirmPassword')}
                    </Text>
                    <View style={[styles.inputContainer, { borderColor: theme.colors.divider }]}>
                        <TextInput
                            style={[styles.input, { color: theme.colors.text }]}
                            value={confirmPassword}
                            onChangeText={setConfirmPassword}
                            placeholder={t('password.confirmPassword')}
                            placeholderTextColor={theme.colors.textSecondary}
                            secureTextEntry={!showConfirmPassword}
                            autoComplete="new-password"
                            textContentType="newPassword"
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <Pressable
                            onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                            style={styles.toggleButton}
                        >
                            <Ionicons
                                name={showConfirmPassword ? 'eye-off-outline' : 'eye-outline'}
                                size={20}
                                color={theme.colors.textSecondary}
                            />
                        </Pressable>
                    </View>

                    {/* Password Match Indicator */}
                    {confirmPassword.length > 0 && (
                        <View style={styles.matchContainer}>
                            <Ionicons
                                name={newPassword === confirmPassword ? 'checkmark-circle' : 'close-circle'}
                                size={16}
                                color={newPassword === confirmPassword ? '#34C759' : '#FF3B30'}
                            />
                            <Text style={[
                                styles.matchText,
                                { color: newPassword === confirmPassword ? '#34C759' : '#FF3B30' }
                            ]}>
                                {newPassword === confirmPassword
                                    ? t('password.passwordsMatch')
                                    : t('password.passwordMismatch')
                                }
                            </Text>
                        </View>
                    )}
                </View>

                {/* Action Buttons */}
                <View style={styles.buttonContainer}>
                    <Pressable
                        style={[
                            styles.changeButton,
                            {
                                backgroundColor: currentPassword.trim() &&
                                                newPassword.trim() &&
                                                confirmPassword.trim() &&
                                                newPassword === confirmPassword &&
                                                passwordStrength?.isValid &&
                                                !isLoading
                                    ? theme.colors.text
                                    : theme.colors.input.background,
                            },
                        ]}
                        onPress={handleChangePassword}
                        disabled={!currentPassword.trim() ||
                                 !newPassword.trim() ||
                                 !confirmPassword.trim() ||
                                 newPassword !== confirmPassword ||
                                 !passwordStrength?.isValid ||
                                 isLoading}
                    >
                        <Text style={[
                            styles.buttonText,
                            {
                                color: currentPassword.trim() &&
                                       newPassword.trim() &&
                                       confirmPassword.trim() &&
                                       newPassword === confirmPassword &&
                                       passwordStrength?.isValid &&
                                       !isLoading
                                    ? theme.colors.surface
                                    : theme.colors.textSecondary,
                            },
                        ]}>
                            {isLoading ? t('common.saving') + '...' : t('password.changePassword')}
                        </Text>
                    </Pressable>

                    <Pressable
                        style={styles.cancelButton}
                        onPress={handleCancel}
                        disabled={isLoading}
                    >
                        <Text style={[styles.cancelText, { color: theme.colors.textSecondary }]}>
                            {t('common.cancel')}
                        </Text>
                    </Pressable>
                </View>
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    content: {
        paddingHorizontal: 24,
        paddingBottom: 40,
    },
    header: {
        alignItems: 'center',
        paddingTop: 40,
        paddingBottom: 40,
    },
    title: {
        fontSize: 28,
        marginTop: 16,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 16,
        marginTop: 8,
        textAlign: 'center',
        ...Typography.default(),
    },
    form: {
        gap: 24,
    },
    inputGroup: {
        gap: 8,
    },
    label: {
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.input.background,
    },
    input: {
        flex: 1,
        fontSize: 16,
        ...Typography.default(),
    },
    toggleButton: {
        padding: 4,
    },
    strengthContainer: {
        gap: 8,
    },
    strengthBar: {
        height: 4,
        backgroundColor: theme.colors.divider,
        borderRadius: 2,
        overflow: 'hidden',
    },
    strengthFill: {
        height: '100%',
        borderRadius: 2,
    },
    strengthText: {
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    feedbackContainer: {
        gap: 4,
    },
    feedbackText: {
        fontSize: 14,
        ...Typography.default(),
    },
    matchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    matchText: {
        fontSize: 14,
        ...Typography.default(),
    },
    buttonContainer: {
        gap: 16,
        marginTop: 24,
    },
    changeButton: {
        borderRadius: 8,
        paddingVertical: 16,
        alignItems: 'center',
    },
    buttonText: {
        fontSize: 16,
        ...Typography.default('semiBold'),
    },
    cancelButton: {
        alignItems: 'center',
        paddingVertical: 12,
    },
    cancelText: {
        fontSize: 16,
        ...Typography.default(),
    },
}));