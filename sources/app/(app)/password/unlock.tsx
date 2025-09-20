import { Ionicons } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";
import { useRouter } from "expo-router";
import React from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { useAuth } from "@/auth/AuthContext";
import { verifyPassword } from "@/auth/passwordSecurity";
import { Typography } from "@/constants/Typography";
import { Modal } from "@/modal";
import { t } from "@/text";

/**
 * Password unlock screen for session access
 * Shown when password protection is enabled
 */
export default function PasswordUnlockScreen() {
	const { theme } = useUnistyles();
	const router = useRouter();
	const safeArea = useSafeAreaInsets();
	const { login } = useAuth();

	const [password, setPassword] = React.useState("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [attempts, setAttempts] = React.useState(0);
	const [showPassword, setShowPassword] = React.useState(false);
	const [biometricAvailable, setBiometricAvailable] = React.useState(false);

	// Check if biometric authentication is available
	React.useEffect(() => {
		checkBiometricAvailability();
	}, []);

	const checkBiometricAvailability = async () => {
		try {
			const hasHardware = await LocalAuthentication.hasHardwareAsync();
			const isEnrolled = await LocalAuthentication.isEnrolledAsync();
			setBiometricAvailable(hasHardware && isEnrolled);
		} catch (error) {
			console.error("Biometric availability check failed:", error);
			setBiometricAvailable(false);
		}
	};

	// Handle password verification
	const handlePasswordSubmit = async () => {
		if (!password.trim()) {
			Modal.alert(t("password.error"), t("password.enterPassword"));
			return;
		}

		setIsLoading(true);

		try {
			const isValid = await verifyPassword(password);

			if (isValid) {
				console.log("✅ Password verified successfully");
				// Navigate to main app
				router.replace("/");
			} else {
				const newAttempts = attempts + 1;
				setAttempts(newAttempts);
				setPassword("");

				if (newAttempts >= 5) {
					Modal.alert(
						t("password.tooManyAttempts"),
						t("password.tooManyAttemptsMessage"),
						[
							{
								text: t("password.tryBiometric"),
								onPress: handleBiometricAuth,
							},
							{
								text: t("common.cancel"),
								style: "cancel",
							},
						],
					);
				} else {
					Modal.alert(
						t("password.incorrectPassword"),
						t("password.incorrectPasswordMessage", {
							attempts: 5 - newAttempts,
						}),
					);
				}
			}
		} catch (error) {
			console.error("Password verification error:", error);
			Modal.alert(t("common.error"), t("password.verificationError"));
		} finally {
			setIsLoading(false);
		}
	};

	// Handle biometric authentication
	const handleBiometricAuth = async () => {
		if (!biometricAvailable) {
			Modal.alert(
				t("password.biometricUnavailable"),
				t("password.biometricUnavailableMessage"),
			);
			return;
		}

		try {
			const result = await LocalAuthentication.authenticateAsync({
				promptMessage: t("password.biometricPrompt"),
				cancelLabel: t("common.cancel"),
				fallbackLabel: t("password.usePassword"),
			});

			if (result.success) {
				console.log("✅ Biometric authentication successful");
				router.replace("/");
			} else {
				console.log("❌ Biometric authentication failed");
			}
		} catch (error) {
			console.error("Biometric authentication error:", error);
			Modal.alert(t("common.error"), t("password.biometricError"));
		}
	};

	// Handle forgot password
	const handleForgotPassword = () => {
		router.push("/password/recovery");
	};

	return (
		<View style={[styles.container, { paddingTop: safeArea.top }]}>
			{/* Header */}
			<View style={styles.header}>
				<Ionicons name="shield-checkmark" size={64} color={theme.colors.text} />
				<Text style={[styles.title, { color: theme.colors.text }]}>
					{t("password.unlockSession")}
				</Text>
				<Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
					{t("password.unlockSessionDescription")}
				</Text>
			</View>

			{/* Password Input */}
			<View style={styles.form}>
				<View
					style={[
						styles.inputContainer,
						{ backgroundColor: theme.colors.input.background },
					]}
				>
					<Ionicons
						name="key-outline"
						size={20}
						color={theme.colors.textSecondary}
						style={styles.inputIcon}
					/>
					<TextInput
						style={[styles.input, { color: theme.colors.text }]}
						placeholder={t("password.enterPassword")}
						placeholderTextColor={theme.colors.textSecondary}
						value={password}
						onChangeText={setPassword}
						secureTextEntry={!showPassword}
						autoCapitalize="none"
						autoComplete="password"
						textContentType="password"
						onSubmitEditing={handlePasswordSubmit}
						editable={!isLoading}
					/>
					<Pressable
						onPress={() => setShowPassword(!showPassword)}
						style={styles.eyeButton}
					>
						<Ionicons
							name={showPassword ? "eye-off-outline" : "eye-outline"}
							size={20}
							color={theme.colors.textSecondary}
						/>
					</Pressable>
				</View>

				{/* Attempt counter */}
				{attempts > 0 && (
					<Text
						style={[
							styles.attemptText,
							{ color: theme.colors.textDestructive },
						]}
					>
						{t("password.attemptsRemaining", { attempts: 5 - attempts })}
					</Text>
				)}

				{/* Unlock button */}
				<Pressable
					style={[
						styles.unlockButton,
						{
							backgroundColor:
								password.trim() && !isLoading
									? theme.colors.text
									: theme.colors.input.background,
						},
					]}
					onPress={handlePasswordSubmit}
					disabled={!password.trim() || isLoading}
				>
					{isLoading ? (
						<Text
							style={[styles.buttonText, { color: theme.colors.textSecondary }]}
						>
							{t("password.verifying")}
						</Text>
					) : (
						<>
							<Text
								style={[
									styles.buttonText,
									{
										color: password.trim()
											? theme.colors.surface
											: theme.colors.textSecondary,
									},
								]}
							>
								{t("password.unlock")}
							</Text>
							<Ionicons
								name="arrow-forward"
								size={20}
								color={
									password.trim()
										? theme.colors.surface
										: theme.colors.textSecondary
								}
							/>
						</>
					)}
				</Pressable>

				{/* Biometric button */}
				{biometricAvailable && (
					<Pressable
						style={[
							styles.biometricButton,
							{ borderColor: theme.colors.divider },
						]}
						onPress={handleBiometricAuth}
						disabled={isLoading}
					>
						<Ionicons
							name={Platform.OS === "ios" ? "finger-print" : "finger-print"}
							size={24}
							color={theme.colors.text}
						/>
						<Text style={[styles.biometricText, { color: theme.colors.text }]}>
							{t("password.useBiometric")}
						</Text>
					</Pressable>
				)}

				{/* Forgot password */}
				<Pressable
					style={styles.forgotButton}
					onPress={handleForgotPassword}
					disabled={isLoading}
				>
					<Text
						style={[styles.forgotText, { color: theme.colors.textSecondary }]}
					>
						{t("password.forgotPassword")}
					</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create((theme) => ({
	container: {
		flex: 1,
		backgroundColor: theme.colors.surface,
		paddingHorizontal: 24,
	},
	header: {
		alignItems: "center",
		paddingTop: 60,
		paddingBottom: 40,
	},
	title: {
		fontSize: 28,
		fontWeight: "bold",
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
	form: {
		flex: 1,
		maxWidth: 400,
		alignSelf: "center",
		width: "100%",
	},
	inputContainer: {
		flexDirection: "row",
		alignItems: "center",
		borderRadius: 12,
		paddingHorizontal: 16,
		paddingVertical: Platform.select({ ios: 16, android: 12 }),
		marginBottom: 16,
	},
	inputIcon: {
		marginRight: 12,
	},
	input: {
		flex: 1,
		fontSize: 16,
		...Typography.default(),
	},
	eyeButton: {
		padding: 4,
	},
	attemptText: {
		fontSize: 14,
		textAlign: "center",
		marginBottom: 16,
		...Typography.default(),
	},
	unlockButton: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 12,
		paddingVertical: 16,
		marginBottom: 24,
	},
	buttonText: {
		fontSize: 16,
		fontWeight: "600",
		marginRight: 8,
		...Typography.default("semiBold"),
	},
	biometricButton: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 12,
		borderWidth: 2,
		paddingVertical: 16,
		marginBottom: 24,
	},
	biometricText: {
		fontSize: 16,
		fontWeight: "500",
		marginLeft: 8,
		...Typography.default("semiBold"),
	},
	forgotButton: {
		alignItems: "center",
		paddingVertical: 12,
	},
	forgotText: {
		fontSize: 14,
		...Typography.default(),
	},
}));
