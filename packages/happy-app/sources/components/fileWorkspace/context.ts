import * as React from 'react';
import type { VersionController, RestoreSelection } from './versionController';
import type { FileWorkspaceController, FileWorkspaceSnapshot } from './controller';
export type FileReference = { path: string; hash: string; quote?: string; artifact?: { workspaceId: string; artifactId: string; expectedRevision: string; versionId?: string } };
export type FileWorkspaceContextValue = {
    sessionId: string;
    openRequestId: number;
    versions: VersionController;
    versionSnapshot: ReturnType<VersionController['getSnapshot']>;
    restoreVersion: (path: string, action?: 'inspect' | 'resume' | 'rollback' | 'retry', selection?: RestoreSelection) => Promise<boolean>;
    draftCacheError: boolean;
    enabled: boolean; root: string; controller: FileWorkspaceController; snapshot: FileWorkspaceSnapshot;
    reference: FileReference | null; setReference: React.Dispatch<React.SetStateAction<FileReference | null>>;
    openReference: (path: string) => Promise<void>;
    chatWidth: number; setChatWidth: (width: number) => void;
    maximized: boolean; setMaximized: (value: boolean) => void;
};
export const FileWorkspaceContext = React.createContext<FileWorkspaceContextValue | null>(null);
export const useFileWorkspace = () => React.useContext(FileWorkspaceContext);
