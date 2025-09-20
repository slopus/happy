import * as React from "react";
import { useCallback } from "react";
import { FlatList, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession, useSessionMessages } from "@/sync/storage";
import { Metadata, Session } from "@/sync/storageTypes";
import { Message } from "@/sync/typesMessage";
import { useHeaderHeight } from "@/utils/responsive";
import { ChatFooter } from "./ChatFooter";
import { MessageView } from "./MessageView";

export const ChatList = React.memo((props: { session: Session }) => {
	const { messages } = useSessionMessages(props.session.id);
	return (
		<ChatListInternal
			metadata={props.session.metadata}
			sessionId={props.session.id}
			messages={messages}
		/>
	);
});

const ListHeader = React.memo(() => {
	const headerHeight = useHeaderHeight();
	const safeArea = useSafeAreaInsets();
	return (
		<View
			style={{
				flexDirection: "row",
				alignItems: "center",
				height: headerHeight + safeArea.top + 32,
			}}
		/>
	);
});

const ListFooter = React.memo((props: { sessionId: string }) => {
	const session = useSession(props.sessionId)!;
	return (
		<ChatFooter
			controlledByUser={session.agentState?.controlledByUser || false}
		/>
	);
});

const ChatListInternal = React.memo(
	(props: {
		metadata: Metadata | null;
		sessionId: string;
		messages: Message[];
	}) => {
		const keyExtractor = useCallback((item: any) => item.id, []);
		const renderItem = useCallback(
			({ item }: { item: any }) => (
				<MessageView
					message={item}
					metadata={props.metadata}
					sessionId={props.sessionId}
				/>
			),
			[props.metadata, props.sessionId],
		);
		return (
			<FlatList
				data={props.messages}
				inverted={true}
				keyExtractor={keyExtractor}
				maintainVisibleContentPosition={{
					minIndexForVisible: 0,
					autoscrollToTopThreshold: 10,
				}}
				keyboardShouldPersistTaps="handled"
				keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "none"}
				renderItem={renderItem}
				ListHeaderComponent={<ListFooter sessionId={props.sessionId} />}
				ListFooterComponent={<ListHeader />}
			/>
		);
	},
);
