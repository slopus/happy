import * as React from 'react';
import { useRoute } from "@react-navigation/native";
import { SessionView } from '@/-session/SessionView';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    return (<SessionView id={sessionId} />);
});