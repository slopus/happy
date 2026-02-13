import * as React from 'react';
import { useNavigation, useRoute } from "@react-navigation/native";
import { SessionView } from '@/-session/SessionView';
import { t } from '@/text';
import AgentHistoryPage from './history';
import RecentSessionsPage from './recent';
import ClaudeSessionsPage from './claude';

// Fallback mapping for when Expo Router on Native incorrectly
// matches static routes against this dynamic [id] route
const STATIC_ROUTES: Record<string, { component: React.ComponentType; title: () => string }> = {
    history: { component: AgentHistoryPage, title: () => t('agentHistory.title') },
    recent: { component: RecentSessionsPage, title: () => t('sessionHistory.title') },
    claude: { component: ClaudeSessionsPage, title: () => t('claudeHistory.title') },
};

export default React.memo(() => {
    const route = useRoute();
    const navigation = useNavigation();
    const sessionId = (route.params! as any).id as string;

    const staticRoute = STATIC_ROUTES[sessionId];

    // When a static route is incorrectly matched as [id], show the header and render the static page.
    // When transitioning away from a static route (e.g. via dangerouslySingular reuse),
    // reset headerShown to false so the native header doesn't persist over SessionView's custom header.
    React.useEffect(() => {
        if (staticRoute) {
            navigation.setOptions({
                headerShown: true,
                headerTitle: staticRoute.title(),
                headerBackTitle: t('common.back'),
            });
        } else {
            navigation.setOptions({
                headerShown: false,
            });
        }
    }, [staticRoute, navigation]);

    if (staticRoute) {
        const StaticComponent = staticRoute.component;
        return <StaticComponent />;
    }

    return (<SessionView id={sessionId} />);
});