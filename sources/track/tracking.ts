import PostHog from 'posthog-react-native';

export const tracking = process.env.EXPO_PUBLIC_POSTHOG_API_KEY ? new PostHog(process.env.EXPO_PUBLIC_POSTHOG_API_KEY, {
    host: 'https://us.i.posthog.com',
    captureAppLifecycleEvents: true,
}) : null;