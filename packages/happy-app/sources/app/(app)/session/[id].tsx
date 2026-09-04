import * as React from 'react';
import { Platform } from 'react-native';
import { useIsFocused, useRoute } from "@react-navigation/native";
import { Freeze } from 'react-freeze';
import { SessionView } from '@/-session/SessionView';


export default React.memo(() => {
    const route = useRoute();
    const sessionId = (route.params! as any).id as string;
    // A stack screen that is not on top stays mounted. On native, native-stack
    // freezes it through `freezeOnBlur`, which waits until the screen is off
    // screen. On web, NativeStackView has no such branch and only sets
    // `display: none`, so the chat below the composer kept reconciling every
    // message of a running agent. Measured on /new with one session left
    // behind: 116 of the 203 component renders per inbound socket frame came
    // from that hidden screen.
    //
    // Web only, on purpose. `useIsFocused` turns false when the push starts,
    // and on native the outgoing screen is still on screen for the length of
    // the animation, so freezing on that flag would blank it mid-transition.
    // The web view reads `display: none` off the same flag, so there the two
    // change together. Native keeps its own machinery.
    //
    // Hidden state is preserved, so returning to the chat does not reload it.
    const isFocused = useIsFocused();
    return (
        <Freeze freeze={Platform.OS === 'web' && !isFocused}>
            <SessionView id={sessionId} />
        </Freeze>
    );
});
