import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { ContextMenu, useContextMenu } from "@/components/ContextMenu";
import {
	copySessionId,
	deleteSession,
	duplicateSession,
	exportSessionHistory,
	renameSession,
} from "@/utils/sessionUtils";

/**
 * Manual test component for Context Menu functionality
 * This tests our session management context menu implementation
 */
export function TestContextMenu() {
	const contextMenu = useContextMenu();

	// Mock session for testing
	const mockSession = {
		id: "test-session-123",
		seq: 1,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		active: true,
		activeAt: Date.now(),
		metadata: {
			summary: "Test Session",
			path: "/test/path",
			host: "test-host",
			machineId: "test-machine",
			claudeSessionId: "claude-123",
			tools: [],
			homeDir: "/home/test",
			flavor: "claude" as const,
		},
		metadataVersion: 1,
		agentState: null,
		agentStateVersion: 0,
		thinking: false,
		thinkingAt: 0,
		presence: "online" as const,
	};

	const contextMenuActions = [
		{
			id: "rename",
			title: "Rename Session",
			icon: "pencil",
			onPress: () => {
				console.log("Testing rename session...");
				renameSession(mockSession.id, mockSession);
				contextMenu.hide();
			},
			accessibilityHint: "Rename this session",
		},
		{
			id: "duplicate",
			title: "Duplicate Session",
			icon: "copy",
			onPress: () => {
				console.log("Testing duplicate session...");
				duplicateSession(mockSession);
				contextMenu.hide();
			},
			accessibilityHint: "Create a copy of this session",
		},
		{
			id: "copy-id",
			title: "Copy Session ID",
			icon: "clipboard",
			onPress: () => {
				console.log("Testing copy session ID...");
				copySessionId(mockSession.id);
				contextMenu.hide();
			},
			accessibilityHint: "Copy session ID to clipboard",
		},
		{
			id: "export",
			title: "Export History",
			icon: "download",
			onPress: () => {
				console.log("Testing export session history...");
				exportSessionHistory(mockSession);
				contextMenu.hide();
			},
			accessibilityHint: "Export session history as JSON",
		},
		{
			id: "delete",
			title: "Delete Session",
			icon: "trash",
			destructive: true,
			onPress: () => {
				console.log("Testing delete session...");
				deleteSession(mockSession.id, mockSession);
				contextMenu.hide();
			},
			accessibilityHint: "Delete this session permanently",
		},
	];

	const handleLongPress = (event: any) => {
		const { pageX, pageY } = event.nativeEvent;
		contextMenu.show({ x: pageX, y: pageY });
	};

	return (
		<View style={{ flex: 1, padding: 20, justifyContent: "center" }}>
			<Text
				style={{
					fontSize: 24,
					fontWeight: "bold",
					marginBottom: 20,
					textAlign: "center",
				}}
			>
				Context Menu Test
			</Text>

			<TouchableOpacity
				onLongPress={handleLongPress}
				style={{
					backgroundColor: "#007AFF",
					padding: 20,
					borderRadius: 10,
					marginBottom: 20,
				}}
			>
				<Text style={{ color: "white", textAlign: "center", fontSize: 16 }}>
					Long Press to Test Context Menu
				</Text>
				<Text
					style={{
						color: "white",
						textAlign: "center",
						fontSize: 12,
						marginTop: 5,
					}}
				>
					Session: {mockSession.metadata?.summary}
				</Text>
			</TouchableOpacity>

			<Text style={{ textAlign: "center", color: "#666", fontSize: 14 }}>
				This tests all session management actions:{"\n"}• Rename Session{"\n"}•
				Duplicate Session{"\n"}• Copy Session ID{"\n"}• Export History{"\n"}•
				Delete Session
			</Text>

			<ContextMenu
				visible={contextMenu.visible}
				onClose={contextMenu.hide}
				actions={contextMenuActions}
				anchorPosition={contextMenu.anchorPosition}
				title="Session Options"
				animationType="scale"
			/>
		</View>
	);
}

// Test function to verify individual utilities
export function testSessionUtils() {
	console.log("🧪 Testing Session Utils...");

	const mockSession = {
		id: "test-utils-123",
		seq: 1,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		active: true,
		activeAt: Date.now(),
		metadata: {
			summary: "Utils Test Session",
			path: "/test/utils",
			host: "test-host",
			machineId: "test-machine",
			claudeSessionId: "claude-utils-123",
			tools: [],
			homeDir: "/home/test",
			flavor: "claude" as const,
		},
		metadataVersion: 1,
		agentState: null,
		agentStateVersion: 0,
		thinking: false,
		thinkingAt: 0,
		presence: "online" as const,
	};

	// Test Copy Session ID (should work without modal)
	console.log("✅ Testing copySessionId...");
	copySessionId(mockSession.id);

	// Test Export Session History
	console.log("✅ Testing exportSessionHistory...");
	exportSessionHistory(mockSession);

	console.log("🎉 Session utils testing complete! Check console for results.");
}

export default TestContextMenu;
