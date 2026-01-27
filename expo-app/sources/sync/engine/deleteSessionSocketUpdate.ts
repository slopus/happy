import type { Encryption } from '../encryption/encryption';

export function handleDeleteSessionSocketUpdate(params: {
    sessionId: string;
    deleteSession: (sessionId: string) => void;
    encryption: Encryption;
    removeProjectManagerSession: (sessionId: string) => void;
    clearGitStatusForSession: (sessionId: string) => void;
    log: { log: (message: string) => void };
}) {
    const { sessionId, deleteSession, encryption, removeProjectManagerSession, clearGitStatusForSession, log } = params;

    // Remove session from storage
    deleteSession(sessionId);

    // Remove encryption keys from memory
    encryption.removeSessionEncryption(sessionId);

    // Remove from project manager
    removeProjectManagerSession(sessionId);

    // Clear any cached git status
    clearGitStatusForSession(sessionId);

    log.log(`🗑️ Session ${sessionId} deleted from local storage`);
}

