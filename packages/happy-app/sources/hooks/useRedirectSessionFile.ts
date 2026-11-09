import * as React from 'react';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { useDesktopFileWorkspaceAvailable } from './useDesktopFileWorkspaceAvailable';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { sessionFileWorkspaceHref } from '@/utils/sessionFileNavigation';

/** Old URLs and history entries rejoin the same desktop workspace. */
export function useRedirectSessionFile(sessionId: string, path: string, positioned: boolean) {
    const desktopAvailable = useDesktopFileWorkspaceAvailable();
    const session = useSession(sessionId);
    const router = useRouter();
    const redirect = desktopAvailable && !positioned
        && !!resolveSessionFilePath(path, session?.metadata?.path)?.withinSessionRoot;
    React.useEffect(() => {
        if (redirect) router.navigate(sessionFileWorkspaceHref(sessionId, path));
    }, [redirect, sessionId, path]);
    return redirect;
}
