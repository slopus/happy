import { config } from '@/config';
import PostHog from 'posthog-react-native';

export const tracking = config.postHogKey ? new PostHog(config.postHogKey, {
    host: 'https://us.i.posthog.com',
    captureAppLifecycleEvents: true,
}) : null;