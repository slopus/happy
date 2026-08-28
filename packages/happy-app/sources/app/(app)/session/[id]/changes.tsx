/**
 * Every uncommitted change in the session's working tree, as one scrollable
 * diff.
 *
 * The same view exists inside the session as a sidebar overlay, but that needs
 * a screen wide enough to show a sidebar at all — on a phone there was no way
 * in. This route is that way in, so the diff is reachable from the session menu
 * on any screen size.
 */

import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { AllFilesDiffView } from '@/components/AllFilesDiffView';
import { sync } from '@/sync/sync';
import { useGitStatusFiles } from '@/hooks/useGitStatusFiles';
import { useUnistyles } from 'react-native-unistyles';

export default React.memo(function SessionChangesScreen() {
    const { id: sessionId, file } = useLocalSearchParams<{ id: string; file?: string }>();
    const { theme } = useUnistyles();

    // The in-session overlay publishes its controls into the chat header; here
    // there is no such slot, so the screen keeps them to itself.
    const [headerRight, setHeaderRight] = React.useState<React.ReactNode>(null);

    // Opened outside the chat, so nothing else has told sync this session is on
    // screen — without it the git status backing the diff goes stale.
    React.useEffect(() => {
        if (sessionId) {
            sync.onSessionVisible(sessionId);
        }
    }, [sessionId]);

    // AllFilesDiffView only reads the git status cache; in the session sidebar
    // something else keeps that cache warm, but on a route of its own nobody
    // does, and the screen would sit there claiming there is nothing to show.
    useGitStatusFiles(sessionId!);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <Stack.Screen
                options={{
                    headerRight: () => (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {headerRight}
                        </View>
                    ),
                }}
            />
            <AllFilesDiffView
                sessionId={sessionId!}
                scrollToFile={file ? decodeURIComponent(file) : null}
                onHeaderRightSlotChange={setHeaderRight}
            />
        </View>
    );
});
