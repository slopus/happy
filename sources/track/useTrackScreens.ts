import { useSegments } from "expo-router";
import { tracking } from "./tracking";
import React from "react";

export function useTrackScreens() {
    if (tracking) {
        const route = useSegments().filter(segment => !segment.startsWith('(')).join('/'); // Using segments before normalizing to avoid leaking any params
        React.useEffect(() => { tracking?.screen(route); }, [route]); // NOTE: NO PARAMS HERE - we dont want to leak anything at all, except very basic stuff
    }
}