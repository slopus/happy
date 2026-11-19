import * as React from 'react';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { useDesktopFileWorkspaceAvailable } from './useDesktopFileWorkspaceAvailable';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { sessionFileWorkspaceHref } from '@/utils/sessionFileNavigation';
import { filePathWithLocation } from '@/utils/fileLocation';

/** Desktop legacy URLs always wait for their owning workspace, never mount the old reader. */
export function useRedirectSessionFile(sessionId: string, path: string, location?: { line?: string; column?: string }) {
    const desktopAvailable = useDesktopFileWorkspaceAvailable();
    const session = useSession(sessionId);
    const router = useRouter();
    const target = filePathWithLocation(path, location?.line, location?.column);
    const ready = desktopAvailable && !!session?.metadata?.path
        && !!resolveSessionFilePath(target, session.metadata.path);
    React.useEffect(() => {
        if (ready) router.navigate(sessionFileWorkspaceHref(sessionId, target));
    }, [ready, sessionId, target]);
    return desktopAvailable;
}
