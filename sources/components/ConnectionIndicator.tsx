import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Typography } from "@/constants/Typography";
import {
	type ConnectionHealthStatus,
	connectionHealthMonitor,
} from "@/sync/connectionHealth";

export interface ConnectionIndicatorProps {
	compact?: boolean;
	showLatency?: boolean;
	style?: any;
}

const styles = StyleSheet.create((theme) => ({
	container: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 8,
		paddingVertical: 4,
		borderRadius: 12,
		backgroundColor: theme.colors.surfaceHigh,
	},
	compactContainer: {
		paddingHorizontal: 6,
		paddingVertical: 2,
	},
	statusDot: {
		width: 8,
		height: 8,
		borderRadius: 4,
		marginRight: 6,
	},
	statusText: {
		...Typography.default(),
		fontSize: 12,
		color: theme.colors.textSecondary,
	},
	latencyText: {
		...Typography.default(),
		fontSize: 11,
		color: theme.colors.textSecondary,
		fontFamily: Platform.select({
			ios: "Menlo",
			android: "monospace",
			default: "monospace",
		}),
		marginLeft: 4,
	},
	icon: {
		marginRight: 4,
	},
}));

export const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({
	compact = false,
	showLatency = false,
	style,
}) => {
	const [status, setStatus] = useState<ConnectionHealthStatus>(
		connectionHealthMonitor.getStatus(),
	);

	useEffect(() => {
		const unsubscribe = connectionHealthMonitor.addListener(setStatus);
		return unsubscribe;
	}, []);

	const getStatusIcon = (): keyof typeof Ionicons.glyphMap => {
		switch (status.state) {
			case "connected":
				switch (status.quality) {
					case "excellent":
					case "good":
						return "wifi";
					case "poor":
						return "wifi-outline";
					case "failed":
						return "warning";
					default:
						return "help-circle-outline";
				}
			case "connecting":
			case "reconnecting":
				return "sync";
			case "offline":
			case "failed":
				return "cloud-offline";
			default:
				return "help-circle-outline";
		}
	};

	const getStatusColor = (): string => {
		return connectionHealthMonitor.getQualityColor();
	};

	const getStatusText = (): string => {
		if (compact) {
			switch (status.state) {
				case "connected":
					return status.quality.charAt(0).toUpperCase();
				case "connecting":
					return "...";
				case "offline":
					return "Off";
				case "failed":
					return "Fail";
				default:
					return "?";
			}
		}

		return connectionHealthMonitor.getStatusDescription();
	};

	const latencyDisplay =
		showLatency && status.latency !== null ? `${status.latency}ms` : "";

	return (
		<View style={[styles.container, compact && styles.compactContainer, style]}>
			<Ionicons
				name={getStatusIcon()}
				size={compact ? 12 : 14}
				color={getStatusColor()}
				style={styles.icon}
			/>

			{!compact && (
				<>
					<View
						style={[styles.statusDot, { backgroundColor: getStatusColor() }]}
					/>
					<Text style={styles.statusText}>{getStatusText()}</Text>
					{latencyDisplay && (
						<Text style={styles.latencyText}>{latencyDisplay}</Text>
					)}
				</>
			)}
		</View>
	);
};

// Minimal version for headers/toolbars
export const ConnectionDot: React.FC<{ size?: number }> = ({ size = 6 }) => {
	const [status, setStatus] = useState<ConnectionHealthStatus>(
		connectionHealthMonitor.getStatus(),
	);

	useEffect(() => {
		const unsubscribe = connectionHealthMonitor.addListener(setStatus);
		return unsubscribe;
	}, []);

	const color = connectionHealthMonitor.getQualityColor();

	return (
		<View
			style={{
				width: size,
				height: size,
				borderRadius: size / 2,
				backgroundColor: color,
			}}
		/>
	);
};

export default ConnectionIndicator;
