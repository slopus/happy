import { Ionicons } from "@expo/vector-icons";
import * as React from "react";
import {
	AccessibilityInfo,
	Animated,
	Dimensions,
	findNodeHandle,
	Modal,
	Platform,
	Pressable,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Typography } from "@/constants/Typography";

export interface ContextMenuAction {
	id: string;
	title: string;
	icon?: string;
	destructive?: boolean;
	disabled?: boolean;
	onPress: () => void;
	shortcut?: string;
	accessibilityLabel?: string;
	accessibilityHint?: string;
}

export interface ContextMenuSection {
	id: string;
	title?: string;
	actions: ContextMenuAction[];
}

export interface ContextMenuPosition {
	x: number;
	y: number;
}

interface ContextMenuProps {
	visible: boolean;
	onClose: () => void;
	actions?: ContextMenuAction[];
	sections?: ContextMenuSection[];
	anchorPosition?: ContextMenuPosition;
	title?: string;
	animationType?: "fade" | "scale" | "slide";
	accessibilityLabel?: string;
	testID?: string;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
	visible,
	onClose,
	actions,
	sections,
	anchorPosition,
	title,
	animationType = "scale",
	accessibilityLabel,
	testID,
}) => {
	const { theme } = useUnistyles();
	const safeArea = useSafeAreaInsets();
	const [menuPosition, setMenuPosition] = React.useState({ x: 0, y: 0 });
	const [menuSize, setMenuSize] = React.useState({ width: 0, height: 0 });

	// Animation values
	const scaleAnim = React.useRef(new Animated.Value(0)).current;
	const fadeAnim = React.useRef(new Animated.Value(0)).current;
	const slideAnim = React.useRef(new Animated.Value(-10)).current;

	// Ref for focus management
	const menuRef = React.useRef<View>(null);

	// Normalize actions - handle both direct actions and sections
	const normalizedSections = React.useMemo((): ContextMenuSection[] => {
		if (sections) {
			return sections;
		}
		if (actions) {
			return [{ id: "default", actions }];
		}
		return [];
	}, [actions, sections]);

	const allActions = React.useMemo(() => {
		return normalizedSections.flatMap((section) => section.actions);
	}, [normalizedSections]);

	// Animation effects
	React.useEffect(() => {
		if (visible) {
			const animations = [];

			if (animationType === "scale" || animationType === "fade") {
				animations.push(
					Animated.timing(fadeAnim, {
						toValue: 1,
						duration: Platform.select({ ios: 200, android: 150, default: 200 }),
						useNativeDriver: true,
					}),
				);
			}

			if (animationType === "scale") {
				animations.push(
					Animated.spring(scaleAnim, {
						toValue: 1,
						tension: 200,
						friction: 10,
						useNativeDriver: true,
					}),
				);
			}

			if (animationType === "slide") {
				animations.push(
					Animated.timing(slideAnim, {
						toValue: 0,
						duration: Platform.select({ ios: 200, android: 150, default: 200 }),
						useNativeDriver: true,
					}),
					Animated.timing(fadeAnim, {
						toValue: 1,
						duration: Platform.select({ ios: 200, android: 150, default: 200 }),
						useNativeDriver: true,
					}),
				);
			}

			Animated.parallel(animations).start();
		} else {
			// Reset animations
			scaleAnim.setValue(0);
			fadeAnim.setValue(0);
			slideAnim.setValue(-10);
		}
	}, [visible, animationType, scaleAnim, fadeAnim, slideAnim]);

	// Calculate menu position based on anchor and screen bounds
	React.useEffect(() => {
		if (!visible || !anchorPosition) return;

		const screenWidth = Dimensions.get("window").width;
		const screenHeight = Dimensions.get("window").height;

		// Estimate menu dimensions more accurately
		const baseWidth = Platform.select({ ios: 220, android: 240, default: 260 });
		const estimatedWidth = Math.max(
			baseWidth,
			title ? title.length * 8 + 40 : baseWidth,
		);

		let estimatedHeight = 20; // Base padding
		if (title) estimatedHeight += 60;

		normalizedSections.forEach((section) => {
			if (section.title) estimatedHeight += 40; // Section header
			estimatedHeight += section.actions.length * 50; // Action items
			estimatedHeight += 8; // Section padding
		});

		estimatedHeight += safeArea.bottom;

		let x = anchorPosition.x;
		let y = anchorPosition.y;

		// Adjust horizontal position if menu would overflow
		if (x + estimatedWidth > screenWidth - 20) {
			x = screenWidth - estimatedWidth - 20;
		}
		if (x < 20) {
			x = 20;
		}

		// Adjust vertical position if menu would overflow
		if (y + estimatedHeight > screenHeight - 20) {
			y = screenHeight - estimatedHeight - 20;
		}
		if (y < safeArea.top + 20) {
			y = safeArea.top + 20;
		}

		setMenuPosition({ x, y });
	}, [
		visible,
		anchorPosition,
		allActions.length,
		title,
		safeArea,
		normalizedSections,
	]);

	// Focus management for accessibility
	React.useEffect(() => {
		if (visible && menuRef.current && Platform.OS !== "web") {
			const nodeHandle = findNodeHandle(menuRef.current);
			if (nodeHandle) {
				AccessibilityInfo.setAccessibilityFocus(nodeHandle);
			}
		}
	}, [visible]);

	const handleActionPress = React.useCallback(
		(action: ContextMenuAction) => {
			if (action.disabled) return;
			onClose();
			// Small delay to ensure modal closes before action
			setTimeout(() => action.onPress(), 100);
		},
		[onClose],
	);

	const handleOverlayPress = React.useCallback(() => {
		onClose();
	}, [onClose]);

	const getAnimationTransform = () => {
		switch (animationType) {
			case "scale":
				return [{ scale: scaleAnim }];
			case "slide":
				return [{ translateY: slideAnim }];
			case "fade":
			default:
				return [];
		}
	};

	const renderAction = (action: ContextMenuAction, isLast: boolean) => (
		<Pressable
			key={action.id}
			style={({ pressed }) => [
				styles.actionItem,
				{
					backgroundColor: pressed
						? theme.colors.surfacePressed
						: "transparent",
				},
				action.disabled && styles.actionItemDisabled,
				!isLast && {
					borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
					borderBottomColor: theme.colors.divider,
				},
			]}
			onPress={() => handleActionPress(action)}
			disabled={action.disabled}
			accessible={true}
			accessibilityRole="button"
			accessibilityLabel={action.accessibilityLabel || action.title}
			accessibilityHint={action.accessibilityHint}
			accessibilityState={{
				disabled: action.disabled || false,
			}}
			testID={`context-menu-action-${action.id}`}
			android_ripple={{
				color: theme.colors.surfaceRipple,
				borderless: false,
			}}
		>
			<View style={styles.actionContent}>
				{action.icon && (
					<Ionicons
						name={action.icon as any}
						size={20}
						color={
							action.disabled
								? theme.colors.textSecondary
								: action.destructive
									? theme.colors.textDestructive
									: theme.colors.text
						}
						style={styles.actionIcon}
					/>
				)}
				<Text
					style={[
						styles.actionText,
						{
							color: action.disabled
								? theme.colors.textSecondary
								: action.destructive
									? theme.colors.textDestructive
									: theme.colors.text,
						},
					]}
				>
					{action.title}
				</Text>
				{action.shortcut && Platform.OS === "web" && (
					<Text
						style={[styles.shortcutText, { color: theme.colors.textSecondary }]}
					>
						{action.shortcut}
					</Text>
				)}
			</View>
		</Pressable>
	);

	const renderSection = (section: ContextMenuSection, sectionIndex: number) => (
		<View key={section.id}>
			{section.title && (
				<View
					style={[
						styles.sectionHeader,
						{ borderBottomColor: theme.colors.divider },
					]}
				>
					<Text
						style={[
							styles.sectionHeaderText,
							{ color: theme.colors.textSecondary },
						]}
					>
						{section.title}
					</Text>
				</View>
			)}
			<View style={styles.sectionContent}>
				{section.actions.map((action, actionIndex) =>
					renderAction(
						action,
						actionIndex === section.actions.length - 1 &&
							sectionIndex === normalizedSections.length - 1,
					),
				)}
			</View>
			{sectionIndex < normalizedSections.length - 1 && (
				<View
					style={[
						styles.sectionDivider,
						{ backgroundColor: theme.colors.divider },
					]}
				/>
			)}
		</View>
	);

	if (!visible) return null;

	return (
		<Modal
			visible={visible}
			transparent={true}
			animationType="none"
			onRequestClose={onClose}
			accessibilityViewIsModal={true}
			testID={testID}
		>
			{/* Overlay */}
			<Pressable
				style={styles.overlay}
				onPress={handleOverlayPress}
				accessible={false}
			>
				{/* Menu Container */}
				<Animated.View
					ref={menuRef}
					style={[
						styles.menuContainer,
						{
							backgroundColor: theme.colors.surface,
							borderColor: theme.colors.modal.border,
							left: menuPosition.x,
							top: menuPosition.y,
							opacity: fadeAnim,
							transform: getAnimationTransform(),
						},
						Platform.OS === "web" && styles.webShadow,
					]}
					onLayout={(event) => {
						const { width, height } = event.nativeEvent.layout;
						setMenuSize({ width, height });
					}}
					accessible={true}
					accessibilityRole="menu"
					accessibilityLabel={
						accessibilityLabel || `Context menu${title ? ` for ${title}` : ""}`
					}
				>
					{/* Title */}
					{title && (
						<View
							style={[
								styles.titleContainer,
								{ borderBottomColor: theme.colors.divider },
							]}
						>
							<Text
								style={[styles.titleText, { color: theme.colors.text }]}
								accessible={true}
								accessibilityRole="header"
							>
								{title}
							</Text>
						</View>
					)}

					{/* Sections */}
					<View style={styles.sectionsContainer}>
						{normalizedSections.map((section, sectionIndex) =>
							renderSection(section, sectionIndex),
						)}
					</View>
				</Animated.View>
			</Pressable>
		</Modal>
	);
};

// Hook for managing context menu state
export const useContextMenu = () => {
	const [visible, setVisible] = React.useState(false);
	const [anchorPosition, setAnchorPosition] = React.useState<
		ContextMenuPosition | undefined
	>();

	const show = React.useCallback((position?: ContextMenuPosition) => {
		setAnchorPosition(position);
		setVisible(true);
	}, []);

	const hide = React.useCallback(() => {
		setVisible(false);
		setAnchorPosition(undefined);
	}, []);

	return { visible, anchorPosition, show, hide };
};

// Enhanced hook with gesture handlers for different platforms
export const useContextMenuGestures = (
	contextMenu: ReturnType<typeof useContextMenu>,
	onGetPosition?: () => ContextMenuPosition,
) => {
	const handleLongPress = React.useCallback(() => {
		if (Platform.OS !== "web") {
			const position = onGetPosition?.() || { x: 0, y: 0 };
			contextMenu.show(position);
		}
	}, [contextMenu, onGetPosition]);

	const handleRightClick = React.useCallback(
		(event: any) => {
			if (Platform.OS === "web") {
				event.preventDefault();
				const position = {
					x: event.nativeEvent.pageX || event.clientX || 0,
					y: event.nativeEvent.pageY || event.clientY || 0,
				};
				contextMenu.show(position);
			}
		},
		[contextMenu],
	);

	return {
		onLongPress: handleLongPress,
		...(Platform.OS === "web" && {
			onContextMenu: handleRightClick,
		}),
	};
};

const styles = StyleSheet.create((theme) => ({
	overlay: {
		flex: 1,
		backgroundColor: "rgba(0, 0, 0, 0.4)",
	},
	menuContainer: {
		position: "absolute",
		minWidth: Platform.select({ ios: 220, android: 240, default: 260 }),
		maxWidth: Platform.select({ ios: 320, android: 300, default: 340 }),
		borderRadius: Platform.select({ ios: 14, android: 8, default: 12 }),
		borderWidth: Platform.select({ ios: 0.33, android: 0, default: 1 }),
		overflow: "hidden",
		...Platform.select({
			ios: {
				shadowColor: "#000",
				shadowOffset: { width: 0, height: 12 },
				shadowOpacity: 0.3,
				shadowRadius: 20,
			},
			android: {
				elevation: 16,
			},
			web: {
				boxShadow:
					"0 12px 40px rgba(0, 0, 0, 0.25), 0 4px 16px rgba(0, 0, 0, 0.15)",
			},
		}),
	},
	webShadow: {
		boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
	},
	titleContainer: {
		paddingHorizontal: Platform.select({ ios: 16, android: 20, default: 18 }),
		paddingVertical: Platform.select({ ios: 14, android: 16, default: 15 }),
		borderBottomWidth: Platform.select({ ios: 0.33, android: 1, default: 1 }),
	},
	titleText: {
		fontSize: Platform.select({ ios: 16, android: 17, default: 16 }),
		fontWeight: Platform.select({ ios: "600", android: "500", default: "600" }),
		textAlign: "center",
		...Typography.default("semiBold"),
	},
	sectionsContainer: {
		paddingVertical: Platform.select({ ios: 6, android: 8, default: 8 }),
	},
	sectionHeader: {
		paddingHorizontal: Platform.select({ ios: 16, android: 20, default: 18 }),
		paddingVertical: Platform.select({ ios: 8, android: 10, default: 9 }),
		borderBottomWidth: Platform.select({ ios: 0.33, android: 1, default: 1 }),
	},
	sectionHeaderText: {
		fontSize: 14,
		fontWeight: "500",
		...Typography.default("semiBold"),
	},
	sectionContent: {
		// No additional styling needed
	},
	sectionDivider: {
		height: Platform.select({ ios: 8, android: 8, default: 8 }),
	},
	actionItem: {
		paddingHorizontal: Platform.select({ ios: 16, android: 20, default: 18 }),
		paddingVertical: Platform.select({ ios: 12, android: 14, default: 13 }),
		minHeight: Platform.select({ ios: 48, android: 52, default: 50 }),
		justifyContent: "center",
	},
	actionItemDisabled: {
		opacity: 0.5,
	},
	actionContent: {
		flexDirection: "row",
		alignItems: "center",
	},
	actionIcon: {
		marginRight: 12,
	},
	actionText: {
		fontSize: 16,
		flex: 1,
		...Typography.default(),
	},
	shortcutText: {
		fontSize: 14,
		...Typography.default(),
	},
}));
