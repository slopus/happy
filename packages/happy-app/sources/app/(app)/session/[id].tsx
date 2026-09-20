import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { SessionView } from '@/-session/SessionView';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    // On web the session route is singular (see useNavigateToSession): a hop
    // to another session reuses this route's key and only swaps the params,
    // so key the view on the id to remount exactly what a fresh push would.
    return (<SessionView key={sessionId} id={sessionId} />);
});