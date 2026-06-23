import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SessionView } from '@/-session/SessionView';


export default React.memo(() => {
    const { id, autoVoice } = useLocalSearchParams<{ id: string; autoVoice?: string }>();
    const shouldAutoStartVoice = autoVoice === '1' || autoVoice === 'true';
    return (<SessionView id={id} autoVoice={shouldAutoStartVoice} />);
});
