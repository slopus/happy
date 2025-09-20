import { useSegments } from "expo-router";
import React from "react";

import { tracking } from "./tracking";

export function useTrackScreens() {
	// Move hooks outside conditional
	const segments = useSegments();
	const route = segments
		.filter((segment) => !segment.startsWith("("))
		.join("/"); // Using segments before normalizing to avoid leaking any params

	React.useEffect(() => {
		if (tracking) {
			tracking.screen(route);
		}
	}, [route]); // NOTE: NO PARAMS HERE - we dont want to leak anything at all, except very basic stuff
}
