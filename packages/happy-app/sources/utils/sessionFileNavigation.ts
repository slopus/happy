import { encodeFilePath } from './filePathEncoding';
let requestSequence = 0;

/** Navigate back to the owning conversation, including repeated opens of one path. */
export function sessionFileWorkspaceHref(sessionId: string, path: string) {
    return {
        pathname: '/session/[id]' as const,
        params: { id: sessionId, openFile: decodeURIComponent(encodeFilePath(path)), fileOpenRequest: `${Date.now()}-${++requestSequence}` },
    };
}

export function legacySessionFileHref(sessionId: string, path: string) {
    return `/session/${sessionId}/file?path=${encodeFilePath(path)}` as const;
}
