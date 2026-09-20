import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { SessionView } from '@/-session/SessionView';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    // The web session route is singular (see useNavigateToSession): a hop to
    // another session reuses the route key and only swaps params, so key the
    // view on the id to remount the session-local state.
    return (<SessionView key={sessionId} id={sessionId} />);
});