import PostHog from "posthog-react-native";

import { config } from "@/config";

export const tracking = config.postHogKey
	? new PostHog(config.postHogKey, {
			host: "https://us.i.posthog.com",
			captureAppLifecycleEvents: true,
		})
	: null;
