import * as React from 'react';
import { useRouter } from 'expo-router';

import { RelationshipAdvisorPluginConfiguration } from '@/components/plugins/RelationshipAdvisorPluginConfiguration';

export default React.memo(function RelationshipAdvisorPluginSettingsScreen() {
    const router = useRouter();
    const openAdvisor = React.useCallback(() => {
        router.replace('/relationship-advisor' as any);
    }, [router]);

    return <RelationshipAdvisorPluginConfiguration onInstalled={openAdvisor} />;
});
