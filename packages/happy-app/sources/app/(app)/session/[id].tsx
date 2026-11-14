import { useSession } from '@/sync/storage';
import { isRetiredSession } from '@/sync/retiredSessions';
import { Redirect } from 'expo-router';
import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { SessionView } from '@/-session/SessionView';
import { decodeFilePath } from '@/utils/filePathEncoding';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    const session = useSession(sessionId);
    if (session && isRetiredSession(session)) return <Redirect href="/bots" />;
    const params = route.params as { openFile?: string; fileOpenRequest?: string };
    let fileOpenRequest;
    if (params.openFile) {
        try { fileOpenRequest = { path: decodeFilePath(params.openFile), requestId: params.fileOpenRequest ?? params.openFile }; }
        catch { /* Ignore malformed desktop file handoffs. */ }
    }
    return (<SessionView id={sessionId} fileOpenRequest={fileOpenRequest} />);
});