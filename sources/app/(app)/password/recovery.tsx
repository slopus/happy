import { Ionicons } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";
import { useRouter } from "expo-router";
import React from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { useAuth } from "@/auth/AuthContext";
import {
	clearPasswordData,
	getAvailableBiometricTypes,
	isBiometricAuthenticationAvailable,
	PASSWORD_STORAGE_KEYS,
	secureStoreDelete,
	setPasswordProtection,
} from "@/auth/passwordSecurity";
import { Typography } from "@/constants/Typography";
import { Modal } from "@/modal";
import { t } from "@/text";

/**
 * Password recovery screen with multiple recovery options
 */
export default function PasswordRecoveryScreen() {
	const { theme } = useUnistyles();
	const router = useRouter();
	const safeArea = useSafeAreaInsets();
	const auth = useAuth();

	const [biometricAvailable, setBiometricAvailable] = React.useState(false);
	const [biometricTypes, setBiometricTypes] = React.useState<
		LocalAuthentication.AuthenticationType[]
	>([]);
	const [isLoading, setIsLoading] = React.useState(false);

	// Check biometric availability on mount
	React.useEffect(() => {
		const checkBiometrics = async () => {
			try {
				const available = await isBiometricAuthenticationAvailable();
				const types = await getAvailableBiometricTypes();
				setBiometricAvailable(available);
				setBiometricTypes(types);
			} catch (error) {
				console.error("Failed to check biometric availability:", error);
				setBiometricAvailable(false);
				setBiometricTypes([]);
			}
		};

		checkBiometrics();
	}, []);

	// Handle biometric password reset
	const handleBiometricReset = async () => {
		if (!biometricAvailable) {
			Modal.alert(
				t("password.biometricUnavailable"),
				t("password.biometricUnavailableMessage"),
			);
			return;
		}

		try {
			setIsLoading(true);

			const result = await LocalAuthentication.authenticateAsync({
				promptMessage: t("password.biometricResetPrompt"),
				cancelLabel: t("common.cancel"),
				fallbackLabel: t("password.useOtherMethod"),
				requireConfirmation: true,
			});

			if (result.success) {
				// User authenticated with biometrics, allow password reset
				const confirmed = await Modal.confirm(
					t("password.resetPasswordTitle"),
					t("password.resetPasswordBiometric"),
					{
						confirmText: t("password.resetPassword"),
						destructive: true,
					},
				);

				if (confirmed) {
					await resetPassword();
				}
			} else {
				console.log("Biometric authentication cancelled or failed");
			}
		} catch (error) {
			console.error("Biometric authentication error:", error);
			Modal.alert(t("password.error"), t("password.biometricError"));
		} finally {
			setIsLoading(false);
		}
	};

	// Handle complete app reset
	const handleAppReset = async () => {
		const confirmed = await Modal.confirm(
			t("password.resetAppTitle"),
			t("password.resetAppWarning"),
			{
				confirmText: t("password.resetApp"),
				cancelText: t("common.cancel"),
				destructive: true,
			},
		);

		if (!confirmed) return;

		// Double confirmation for destructive action
		const doubleConfirmed = await Modal.confirm(
			t("password.confirmReset"),
			t("password.confirmResetMessage"),
			{
				confirmText: t("password.yesResetEverything"),
				cancelText: t("common.cancel"),
				destructive: true,
			},
		);

		if (doubleConfirmed) {
			try {
				setIsLoading(true);
				await performAppReset();
			} catch (error) {
				console.error("Failed to reset app:", error);
				Modal.alert(t("password.error"), t("errors.operationFailed"));
			} finally {
				setIsLoading(false);
			}
		}
	};

	// Handle secret key recovery
	const handleSecretKeyRecovery = () => {
		router.push("/restore/manual");
	};

	// Reset password while keeping session data
	const resetPassword = async () => {
		try {
			// Clear password data but keep session data
			await clearPasswordData();
			await setPasswordProtection(false);

			// Update auth context
			await auth.checkPasswordProtection();

			Modal.alert(t("common.success"), t("password.passwordResetSuccess"), [
				{
					text: t("common.ok"),
					onPress: () => router.replace("/"),
				},
			]);
		} catch (error) {
			console.error("Failed to reset password:", error);
			throw error;
		}
	};

	// Perform complete app reset
	const performAppReset = async () => {
		try {
			// Clear all password data
			await clearPasswordData();

			// Clear all secure storage
			const allKeys = Object.values(PASSWORD_STORAGE_KEYS);
			await Promise.all(allKeys.map((key) => secureStoreDelete(key)));

			// Logout user (this will clear all data)
			await auth.logout();
		} catch (error) {
			console.error("Failed to perform app reset:", error);
			throw error;
		}
	};

	const getBiometricIconName = (): keyof typeof Ionicons.glyphMap => {
		if (
			biometricTypes.includes(
				LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
			)
		) {
			return "scan-outline";
		} else if (
			biometricTypes.includes(
				LocalAuthentication.AuthenticationType.FINGERPRINT,
			)
		) {
			return "finger-print-outline";
		} else {
			return "scan-outline";
		}
	};

	const getBiometricLabel = (): string => {
		if (Platform.OS === "ios") {
			if (
				biometricTypes.includes(
					LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
				)
			) {
				return t("password.useFaceID");
			} else if (
				biometricTypes.includes(
					LocalAuthentication.AuthenticationType.FINGERPRINT,
				)
			) {
				return t("password.useTouchID");
			}
		} else if (Platform.OS === "android") {
			return t("password.useBiometric");
		}
		return t("password.useBiometric");
	};

	return (
		<ScrollView
			style={[styles.container, { paddingTop: safeArea.top }]}
			contentContainerStyle={styles.content}
		>
			{/* Header */}
			<View style={styles.header}>
				<Ionicons
					name="help-circle-outline"
					size={64}
					color={theme.colors.text}
				/>
				<Text style={[styles.title, { color: theme.colors.text }]}>
					{t("password.recoveryTitle")}
				</Text>
				<Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
					{t("password.recoveryDescription")}
				</Text>
			</View>

			{/* Recovery Options */}
			<View style={styles.optionsContainer}>
				{/* Biometric Recovery (if available) */}
				{biometricAvailable && (
					<Pressable
						style={[
							styles.optionCard,
							{ backgroundColor: theme.colors.input.background },
						]}
						onPress={handleBiometricReset}
						disabled={isLoading}
					>
						<View style={styles.optionHeader}>
							<Ionicons
								name={getBiometricIconName()}
								size={32}
								color="#34C759"
							/>
							<View style={styles.optionTextContainer}>
								<Text
									style={[styles.optionTitle, { color: theme.colors.text }]}
								>
									{getBiometricLabel()}
								</Text>
								<Text
									style={[
										styles.optionDescription,
										{ color: theme.colors.textSecondary },
									]}
								>
									{t("password.biometricRecoveryDescription")}
								</Text>
							</View>
						</View>
						<Ionicons
							name="chevron-forward"
							size={20}
							color={theme.colors.textSecondary}
						/>
					</Pressable>
				)}

				{/* Secret Key Recovery */}
				<Pressable
					style={[
						styles.optionCard,
						{ backgroundColor: theme.colors.input.background },
					]}
					onPress={handleSecretKeyRecovery}
					disabled={isLoading}
				>
					<View style={styles.optionHeader}>
						<Ionicons name="key-outline" size={32} color="#007AFF" />
						<View style={styles.optionTextContainer}>
							<Text style={[styles.optionTitle, { color: theme.colors.text }]}>
								{t("password.useSecretKey")}
							</Text>
							<Text
								style={[
									styles.optionDescription,
									{ color: theme.colors.textSecondary },
								]}
							>
								{t("password.secretKeyRecoveryDescription")}
							</Text>
						</View>
					</View>
					<Ionicons
						name="chevron-forward"
						size={20}
						color={theme.colors.textSecondary}
					/>
				</Pressable>

				{/* Complete Reset (Destructive) */}
				<Pressable
					style={[
						styles.optionCard,
						styles.destructiveCard,
						{ backgroundColor: theme.colors.input.background },
					]}
					onPress={handleAppReset}
					disabled={isLoading}
				>
					<View style={styles.optionHeader}>
						<Ionicons name="trash-outline" size={32} color="#FF3B30" />
						<View style={styles.optionTextContainer}>
							<Text style={[styles.optionTitle, styles.destructiveText]}>
								{t("password.resetApp")}
							</Text>
							<Text
								style={[
									styles.optionDescription,
									{ color: theme.colors.textSecondary },
								]}
							>
								{t("password.resetAppDescription")}
							</Text>
						</View>
					</View>
					<Ionicons
						name="chevron-forward"
						size={20}
						color={theme.colors.textSecondary}
					/>
				</Pressable>
			</View>

			{/* Footer */}
			<View style={styles.footer}>
				<Text
					style={[styles.footerText, { color: theme.colors.textSecondary }]}
				>
					{t("password.recoveryFooter")}
				</Text>

				<Pressable
					style={styles.backButton}
					onPress={() => router.back()}
					disabled={isLoading}
				>
					<Text style={[styles.backButtonText, { color: theme.colors.text }]}>
						{t("password.backToUnlock")}
					</Text>
				</Pressable>
			</View>

			{/* Loading Overlay */}
			{isLoading && (
				<View style={styles.loadingOverlay}>
					<View
						style={[
							styles.loadingContainer,
							{ backgroundColor: theme.colors.surface },
						]}
					>
						<Text style={[styles.loadingText, { color: theme.colors.text }]}>
							{t("password.processing")}
						</Text>
					</View>
				</View>
			)}
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
		minHeight: "100%",
	},
	header: {
		alignItems: "center",
		paddingTop: 40,
		paddingBottom: 40,
	},
	title: {
		fontSize: 28,
		marginTop: 16,
		textAlign: "center",
		...Typography.default("semiBold"),
	},
	subtitle: {
		fontSize: 16,
		marginTop: 8,
		textAlign: "center",
		...Typography.default(),
	},
	optionsContainer: {
		gap: 16,
		flex: 1,
	},
	optionCard: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		padding: 20,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: theme.colors.divider,
	},
	destructiveCard: {
		borderColor: "#FF3B30",
		borderWidth: 1,
	},
	optionHeader: {
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
	},
	optionTextContainer: {
		marginLeft: 16,
		flex: 1,
	},
	optionTitle: {
		fontSize: 18,
		...Typography.default("semiBold"),
	},
	optionDescription: {
		fontSize: 14,
		marginTop: 4,
		...Typography.default(),
	},
	destructiveText: {
		color: "#FF3B30",
	},
	footer: {
		alignItems: "center",
		paddingTop: 40,
		gap: 20,
	},
	footerText: {
		fontSize: 14,
		textAlign: "center",
		lineHeight: 20,
		...Typography.default(),
	},
	backButton: {
		paddingVertical: 12,
		paddingHorizontal: 24,
	},
	backButtonText: {
		fontSize: 16,
		...Typography.default(),
	},
	loadingOverlay: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: "rgba(0, 0, 0, 0.5)",
		justifyContent: "center",
		alignItems: "center",
	},
	loadingContainer: {
		padding: 24,
		borderRadius: 12,
		alignItems: "center",
	},
	loadingText: {
		fontSize: 16,
		...Typography.default(),
	},
}));
