import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { isPasswordProtectionEnabled } from "@/auth/passwordSecurity";
import { Typography } from "@/constants/Typography";
import { useLocalSettingMutable } from "@/sync/storage";
import { t } from "@/text";

/**
 * Migration banner to help existing users discover and set up password protection
 * Shows on the home screen for users who haven't enabled password protection yet
 */
export function PasswordMigrationBanner() {
	const { theme } = useUnistyles();
	const router = useRouter();
	const [hasPasswordProtection, setHasPasswordProtection] = React.useState<
		boolean | null
	>(null);
	const [bannerDismissed, setBannerDismissed] = useLocalSettingMutable(
		"passwordMigrationBannerDismissed",
	);

	// Check password protection status on mount
	React.useEffect(() => {
		const checkPasswordProtection = async () => {
			try {
				const isEnabled = await isPasswordProtectionEnabled();
				setHasPasswordProtection(isEnabled);
			} catch (error) {
				console.error("Failed to check password protection:", error);
				setHasPasswordProtection(false);
			}
		};

		checkPasswordProtection();
	}, []);

	// Don't show banner if:
	// - Password protection is already enabled
	// - User has dismissed the banner
	// - Still checking status
	if (
		hasPasswordProtection === null ||
		hasPasswordProtection ||
		bannerDismissed
	) {
		return null;
	}

	const handleSetupPassword = () => {
		router.push("/password/setup");
	};

	const handleDismiss = () => {
		setBannerDismissed(true);
	};

	const handleLearnMore = () => {
		// Navigate to a help screen or show more information
		router.push("/settings/account");
	};

	return (
		<View
			style={[
				styles.container,
				{ backgroundColor: theme.colors.input.background },
			]}
		>
			<View style={styles.content}>
				{/* Icon */}
				<View style={[styles.iconContainer, { backgroundColor: "#34C759" }]}>
					<Ionicons name="shield-checkmark" size={24} color="white" />
				</View>

				{/* Content */}
				<View style={styles.textContainer}>
					<Text style={[styles.title, { color: theme.colors.text }]}>
						{t("passwordMigration.title")}
					</Text>
					<Text
						style={[styles.description, { color: theme.colors.textSecondary }]}
					>
						{t("passwordMigration.description")}
					</Text>

					{/* Actions */}
					<View style={styles.actionContainer}>
						<Pressable
							style={[
								styles.primaryButton,
								{ backgroundColor: theme.colors.text },
							]}
							onPress={handleSetupPassword}
						>
							<Text
								style={[
									styles.primaryButtonText,
									{ color: theme.colors.surface },
								]}
							>
								{t("passwordMigration.setupNow")}
							</Text>
						</Pressable>

						<Pressable style={styles.secondaryButton} onPress={handleLearnMore}>
							<Text
								style={[
									styles.secondaryButtonText,
									{ color: theme.colors.text },
								]}
							>
								{t("passwordMigration.learnMore")}
							</Text>
						</Pressable>
					</View>
				</View>

				{/* Dismiss button */}
				<Pressable
					style={styles.dismissButton}
					onPress={handleDismiss}
					hitSlop={10}
				>
					<Ionicons name="close" size={20} color={theme.colors.textSecondary} />
				</Pressable>
			</View>
		</View>
	);
}

/**
 * Compact version of the migration banner for smaller spaces
 */
export function CompactPasswordMigrationBanner() {
	const { theme } = useUnistyles();
	const router = useRouter();
	const [hasPasswordProtection, setHasPasswordProtection] = React.useState<
		boolean | null
	>(null);
	const [bannerDismissed, setBannerDismissed] = useLocalSettingMutable(
		"passwordMigrationBannerDismissed",
	);

	// Check password protection status on mount
	React.useEffect(() => {
		const checkPasswordProtection = async () => {
			try {
				const isEnabled = await isPasswordProtectionEnabled();
				setHasPasswordProtection(isEnabled);
			} catch (error) {
				console.error("Failed to check password protection:", error);
				setHasPasswordProtection(false);
			}
		};

		checkPasswordProtection();
	}, []);

	// Don't show banner if already enabled or dismissed
	if (
		hasPasswordProtection === null ||
		hasPasswordProtection ||
		bannerDismissed
	) {
		return null;
	}

	const handlePress = () => {
		router.push("/password/setup");
	};

	const handleDismiss = () => {
		setBannerDismissed(true);
	};

	return (
		<Pressable
			style={[
				styles.compactContainer,
				{ backgroundColor: theme.colors.input.background },
			]}
			onPress={handlePress}
		>
			<View style={styles.compactContent}>
				<Ionicons name="shield-checkmark-outline" size={20} color="#34C759" />
				<Text style={[styles.compactText, { color: theme.colors.text }]}>
					{t("passwordMigration.compactTitle")}
				</Text>
				<Ionicons
					name="chevron-forward"
					size={16}
					color={theme.colors.textSecondary}
				/>
			</View>

			<Pressable
				style={styles.compactDismissButton}
				onPress={handleDismiss}
				hitSlop={8}
			>
				<Ionicons name="close" size={16} color={theme.colors.textSecondary} />
			</Pressable>
		</Pressable>
	);
}

const styles = StyleSheet.create((theme) => ({
	container: {
		borderRadius: 12,
		padding: 16,
		marginHorizontal: 16,
		marginVertical: 8,
		borderWidth: 1,
		borderColor: theme.colors.divider,
	},
	content: {
		flexDirection: "row",
		alignItems: "flex-start",
	},
	iconContainer: {
		width: 40,
		height: 40,
		borderRadius: 20,
		alignItems: "center",
		justifyContent: "center",
		marginRight: 12,
	},
	textContainer: {
		flex: 1,
	},
	title: {
		fontSize: 16,
		marginBottom: 4,
		...Typography.default("semiBold"),
	},
	description: {
		fontSize: 14,
		lineHeight: 20,
		marginBottom: 12,
		...Typography.default(),
	},
	actionContainer: {
		flexDirection: "row",
		gap: 12,
	},
	primaryButton: {
		paddingHorizontal: 16,
		paddingVertical: 8,
		borderRadius: 8,
	},
	primaryButtonText: {
		fontSize: 14,
		...Typography.default("semiBold"),
	},
	secondaryButton: {
		paddingHorizontal: 16,
		paddingVertical: 8,
	},
	secondaryButtonText: {
		fontSize: 14,
		...Typography.default(),
	},
	dismissButton: {
		padding: 4,
		marginLeft: 8,
	},
	// Compact version styles
	compactContainer: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingVertical: 12,
		marginHorizontal: 16,
		marginVertical: 4,
		borderRadius: 8,
		borderWidth: 1,
		borderColor: theme.colors.divider,
	},
	compactContent: {
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
		gap: 12,
	},
	compactText: {
		fontSize: 14,
		flex: 1,
		...Typography.default("semiBold"),
	},
	compactDismissButton: {
		padding: 4,
		marginLeft: 8,
	},
}));
