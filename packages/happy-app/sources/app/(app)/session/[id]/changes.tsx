/**
 * The session's changes as one scrollable diff. Happy Agent compares the whole
 * workspace against its branch base; legacy CLI sessions show uncommitted work.
 *
 * The same view exists inside the session as a sidebar overlay, but that needs
 * a screen wide enough to show a sidebar at all — on a phone there was no way
 * in. This route is that way in, so the diff is reachable from the session menu
 * on any screen size.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { AllFilesDiffView } from '@/components/AllFilesDiffView';
import { sync } from '@/sync/sync';
import { useGitStatusFiles } from '@/hooks/useGitStatusFiles';
import { useSession } from '@/sync/storage';
import { isRigMetadata } from '@/sync/rig';
import { useUnistyles } from 'react-native-unistyles';

export default React.memo(function SessionChangesScreen() {
    const { id: sessionId, file } = useLocalSearchParams<{ id: string; file?: string }>();
    const { theme } = useUnistyles();
    const session = useSession(sessionId!);

    // Opened outside the chat, so nothing else has told sync this session is on
    // screen — without it the git status backing the diff goes stale.
    React.useEffect(() => {
        if (sessionId) {
            sync.onSessionVisible(sessionId);
        }
    }, [sessionId]);

    // Only the legacy viewer needs the shell-backed status cache. Happy Agent
    // loads its native workspace comparison inside AllFilesDiffView.
    useGitStatusFiles(sessionId!, Boolean(session?.metadata) && !isRigMetadata(session?.metadata));

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
            <AllFilesDiffView
                sessionId={sessionId!}
                scrollToFile={file ? decodeURIComponent(file) : null}
            />
        </View>
    );
});
