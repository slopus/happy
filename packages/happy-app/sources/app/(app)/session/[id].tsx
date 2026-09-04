import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { SessionView } from '@/-session/SessionView';
import { perfMark } from '@/utils/perfLog';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    // The earliest point the app owns after a session is tapped: everything
    // the chat list logs measures from here. Keyed by session because
    // navigating to another session re-renders this same screen instance.
    React.useMemo(() => perfMark(`session-open:${sessionId}`), [sessionId]);
    return (<SessionView id={sessionId} />);
});