import { config } from '@/config';
import PostHog from 'posthog-react-native';

const analyticsDisabled =
    process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === '1' ||
    process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === 'true' ||
    (globalThis as any).__HAPPY_CONFIG__?.disableAnalytics === true;

export const tracking = (!analyticsDisabled && config.postHogKey) ? new PostHog(config.postHogKey, {
    host: 'https://us.i.posthog.com',
    captureAppLifecycleEvents: true,
}) : null;
