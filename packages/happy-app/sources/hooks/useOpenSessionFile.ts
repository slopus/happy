import * as React from 'react';
import { useRouter } from 'expo-router';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { useDesktopFileWorkspaceAvailable } from './useDesktopFileWorkspaceAvailable';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { legacySessionFileHref, sessionFileWorkspaceHref } from '@/utils/sessionFileNavigation';

/** All interactive file entries share the same desktop/native navigation policy. */
export function useOpenSessionFile(sessionId: string | undefined) {
    const workspace = useFileWorkspace();
    const router = useRouter();
    const desktopAvailable = useDesktopFileWorkspaceAvailable();
    return React.useCallback((path: string) => {
        if (!sessionId) return;
        if (desktopAvailable) {
            if (workspace?.enabled && workspace.sessionId === sessionId) {
                if (resolveSessionFilePath(path, workspace.root)?.withinSessionRoot) {
                    void workspace.openReference(path);
                    return;
                }
            } else {
                router.navigate(sessionFileWorkspaceHref(sessionId, path));
                return;
            }
        }
        router.push(legacySessionFileHref(sessionId, path));
    }, [sessionId, workspace, router, desktopAvailable]);
}
