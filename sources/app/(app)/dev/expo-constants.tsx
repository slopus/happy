import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Stack } from "expo-router";
import * as Updates from "expo-updates";
import React, { useState } from "react";
import {
	NativeModules,
	Platform,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";

import { Item } from "@/components/Item";
import { ItemGroup } from "@/components/ItemGroup";
import { ItemList } from "@/components/ItemList";
import { config } from "@/config";
import { Typography } from "@/constants/Typography";
import { Modal } from "@/modal";

interface JsonViewerProps {
	title: string;
	data: any;
	defaultExpanded?: boolean;
}

function JsonViewer({ title, data, defaultExpanded = false }: JsonViewerProps) {
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);

	const handleCopy = async () => {
		try {
			await Clipboard.setStringAsync(JSON.stringify(data, null, 2));
			Modal.alert("Copied", "JSON data copied to clipboard");
		} catch (error) {
			Modal.alert("Error", "Failed to copy to clipboard");
		}
	};

	if (!data) {
		return <Item title={title} detail="Not available" showChevron={false} />;
	}

	return (
		<View style={{ marginBottom: 12 }}>
			<Pressable
				style={{
					flexDirection: "row",
					alignItems: "center",
					paddingHorizontal: 16,
					paddingVertical: 12,
					backgroundColor: "white",
				}}
				onPress={() => setIsExpanded(!isExpanded)}
			>
				<Ionicons
					name={isExpanded ? "chevron-down" : "chevron-forward"}
					size={20}
					color="#8E8E93"
					style={{ marginRight: 8 }}
				/>
				<Text
					style={{ flex: 1, fontSize: 16, ...Typography.default("semiBold") }}
				>
					{title}
				</Text>
				<Pressable onPress={handleCopy} hitSlop={10} style={{ padding: 4 }}>
					<Ionicons name="copy-outline" size={20} color="#007AFF" />
				</Pressable>
			</Pressable>

			{isExpanded && (
				<View
					style={{
						backgroundColor: "#F2F2F7",
						paddingHorizontal: 16,
						paddingVertical: 12,
						marginHorizontal: 16,
						borderRadius: 8,
						marginTop: -4,
					}}
				>
					<ScrollView horizontal showsHorizontalScrollIndicator={true}>
						<Text
							style={{
								fontFamily: Platform.select({
									ios: "Menlo",
									android: "monospace",
								}),
								fontSize: 12,
								color: "#000",
							}}
						>
							{JSON.stringify(data, null, 2)}
						</Text>
					</ScrollView>
				</View>
			)}
		</View>
	);
}

export default function ExpoConstantsScreen() {
	// Get ExponentConstants native module directly
	const ExponentConstants = requireOptionalNativeModule("ExponentConstants");
	const ExpoUpdates = requireOptionalNativeModule("ExpoUpdates");

	// Get raw manifests from native modules (replicating Constants.ts logic)
	let rawExponentManifest = null;
	let parsedExponentManifest = null;
	if (ExponentConstants && ExponentConstants.manifest) {
		rawExponentManifest = ExponentConstants.manifest;
		// On Android, manifest is passed as JSON string
		if (typeof rawExponentManifest === "string") {
			try {
				parsedExponentManifest = JSON.parse(rawExponentManifest);
			} catch (e) {
				parsedExponentManifest = {
					parseError: e instanceof Error ? e.message : String(e),
				};
			}
		} else {
			parsedExponentManifest = rawExponentManifest;
		}
	}

	// Get Updates manifest from native module
	let rawUpdatesManifest = null;
	let parsedUpdatesManifest = null;
	if (ExpoUpdates) {
		if (ExpoUpdates.manifest) {
			rawUpdatesManifest = ExpoUpdates.manifest;
			parsedUpdatesManifest = rawUpdatesManifest;
		} else if (ExpoUpdates.manifestString) {
			rawUpdatesManifest = ExpoUpdates.manifestString;
			try {
				parsedUpdatesManifest = JSON.parse(ExpoUpdates.manifestString);
			} catch (e) {
				parsedUpdatesManifest = {
					parseError: e instanceof Error ? e.message : String(e),
				};
			}
		}
	}

	// Get DevLauncher manifest if available
	let rawDevLauncherManifest = null;
	let parsedDevLauncherManifest = null;
	if (
		NativeModules.EXDevLauncher &&
		NativeModules.EXDevLauncher.manifestString
	) {
		rawDevLauncherManifest = NativeModules.EXDevLauncher.manifestString;
		try {
			parsedDevLauncherManifest = JSON.parse(rawDevLauncherManifest);
		} catch (e) {
			parsedDevLauncherManifest = {
				parseError: e instanceof Error ? e.message : String(e),
			};
		}
	}

	// Get various manifest types from Constants API
	const expoConfig = Constants.expoConfig;
	const manifest = Constants.manifest;
	const manifest2 = Constants.manifest2;

	// Get Updates manifest if available
	let updatesManifest = null;
	try {
		updatesManifest = (Updates as any).manifest;
	} catch (e) {
		// expo-updates might not be available
	}

	// Get update ID and channel
	let updateId = null;
	let releaseChannel = null;
	let channel = null;
	let isEmbeddedLaunch = null;
	try {
		updateId = (Updates as any).updateId;
		releaseChannel = (Updates as any).releaseChannel;
		channel = (Updates as any).channel;
		isEmbeddedLaunch = (Updates as any).isEmbeddedLaunch;
	} catch (e) {
		// Properties might not be available
	}

	// Check if running embedded update
	const isEmbedded = ExpoUpdates?.isEmbeddedLaunch;

	return (
		<>
			<Stack.Screen
				options={{
					title: "Expo Constants",
					headerLargeTitle: false,
				}}
			/>
			<ItemList>
				{/* Main Configuration */}
				<ItemGroup title="Configuration from Constants API">
					<JsonViewer
						title="expoConfig (Current)"
						data={expoConfig}
						defaultExpanded={true}
					/>
					<JsonViewer title="manifest (Legacy)" data={manifest} />
					<JsonViewer title="manifest2" data={manifest2} />
					{updatesManifest && (
						<JsonViewer title="Updates.manifest" data={updatesManifest} />
					)}
				</ItemGroup>

				{/* Raw Native Module Manifests */}
				<ItemGroup title="Raw Native Module Manifests">
					<Item
						title="Is Embedded Launch"
						detail={
							isEmbedded !== undefined
								? isEmbedded
									? "Yes"
									: "No"
								: "Not available"
						}
						showChevron={false}
					/>
					{parsedExponentManifest && (
						<JsonViewer
							title="ExponentConstants.manifest (Embedded)"
							data={parsedExponentManifest}
						/>
					)}
					{parsedUpdatesManifest && (
						<JsonViewer
							title="ExpoUpdates.manifest (OTA)"
							data={parsedUpdatesManifest}
						/>
					)}
					{parsedDevLauncherManifest && (
						<JsonViewer
							title="DevLauncher.manifest"
							data={parsedDevLauncherManifest}
						/>
					)}
				</ItemGroup>

				{/* Raw String Manifests (for debugging) */}
				<ItemGroup title="Raw Manifest Strings">
					{typeof rawExponentManifest === "string" && (
						<JsonViewer
							title="ExponentConstants.manifest (raw string)"
							data={{ raw: rawExponentManifest }}
						/>
					)}
					{typeof rawUpdatesManifest === "string" && (
						<JsonViewer
							title="ExpoUpdates.manifestString (raw)"
							data={{ raw: rawUpdatesManifest }}
						/>
					)}
					{rawDevLauncherManifest && (
						<JsonViewer
							title="DevLauncher.manifestString (raw)"
							data={{ raw: rawDevLauncherManifest }}
						/>
					)}
				</ItemGroup>

				{/* Resolved App Config */}
				<ItemGroup title="Resolved App Config">
					<JsonViewer
						title="Loaded App Config (from @/config)"
						data={config}
						defaultExpanded={true}
					/>
				</ItemGroup>

				{/* System Constants */}
				<ItemGroup title="System Constants">
					<Item
						title="Device ID"
						detail={Constants.deviceId || "Not available"}
						showChevron={false}
					/>
					<Item
						title="Session ID"
						detail={Constants.sessionId}
						showChevron={false}
					/>
					<Item
						title="Installation ID"
						detail={Constants.installationId}
						showChevron={false}
					/>
					<Item
						title="Is Device"
						detail={Constants.isDevice ? "Yes" : "No"}
						showChevron={false}
					/>
					<Item
						title="Debug Mode"
						detail={Constants.debugMode ? "Yes" : "No"}
						showChevron={false}
					/>
					<Item
						title="App Ownership"
						detail={Constants.appOwnership || "N/A"}
						showChevron={false}
					/>
					<Item
						title="Execution Environment"
						detail={Constants.executionEnvironment || "N/A"}
						showChevron={false}
					/>
				</ItemGroup>

				{/* Updates Information */}
				<ItemGroup title="Updates Information">
					<Item
						title="Update ID"
						detail={updateId || "Not available"}
						showChevron={false}
					/>
					<Item
						title="Release Channel"
						detail={releaseChannel || "Not available"}
						showChevron={false}
					/>
					<Item
						title="Channel"
						detail={channel || "Not available"}
						showChevron={false}
					/>
					<Item
						title="Is Embedded Launch"
						detail={
							isEmbeddedLaunch !== undefined
								? isEmbeddedLaunch
									? "Yes"
									: "No"
								: "Not available"
						}
						showChevron={false}
					/>
				</ItemGroup>

				{/* Platform Info */}
				<ItemGroup title="Platform Constants">
					<JsonViewer title="Platform Constants" data={Constants.platform} />
				</ItemGroup>

				{/* System Fonts */}
				<ItemGroup title="System Fonts">
					<JsonViewer title="Available Fonts" data={Constants.systemFonts} />
				</ItemGroup>

				{/* Native Modules Info */}
				<ItemGroup title="Native Modules">
					<Item
						title="ExponentConstants"
						detail={ExponentConstants ? "Available" : "Not available"}
						showChevron={false}
					/>
					<Item
						title="ExpoUpdates"
						detail={ExpoUpdates ? "Available" : "Not available"}
						showChevron={false}
					/>
					<Item
						title="EXDevLauncher"
						detail={NativeModules.EXDevLauncher ? "Available" : "Not available"}
						showChevron={false}
					/>
					{ExponentConstants && (
						<JsonViewer
							title="ExponentConstants (full module)"
							data={ExponentConstants}
						/>
					)}
					{ExpoUpdates && (
						<JsonViewer title="ExpoUpdates (full module)" data={ExpoUpdates} />
					)}
				</ItemGroup>

				{/* Raw Constants Object */}
				<ItemGroup title="All Constants (Debug)">
					<JsonViewer title="Full Constants Object" data={Constants} />
				</ItemGroup>
			</ItemList>
		</>
	);
}
