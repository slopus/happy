import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { AppConversationHistoryView } from '@/components/AppConversationHistoryView';
export default React.memo(function AppConversationScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <AppConversationHistoryView conversationId={typeof id === 'string' ? id : undefined} />;
});
