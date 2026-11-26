import * as React from 'react';
import { ComposeHome } from '@/components/ComposeHome';
import { useLocalSearchParams } from 'expo-router';
import { RoleConfigurationComposeScreen } from '@/components/delegation/RoleConfigurationComposeScreen';

// The `/new` route is the single new-session entry point used across the app
// (phone "+", tablet empty state, home header, command palette, …). It now
// renders the compose-first page in its pushed-screen variant — a back button
// instead of the home drawer/avatar chrome. All callers keep navigating to
// `/new`; they just land on the new page.
export default React.memo(function NewSessionScreen() {
    const params = useLocalSearchParams<{ roleConfiguration?: string | string[] }>();
    const reference = Array.isArray(params.roleConfiguration) ? params.roleConfiguration[0] : params.roleConfiguration;
    if (reference) return <RoleConfigurationComposeScreen key={reference} reference={reference} />;
    return <ComposeHome variant="screen" />;
});
