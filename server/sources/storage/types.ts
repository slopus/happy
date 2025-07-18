declare global {
    namespace PrismaJson {
        // Session message content types
        type SessionMessageContent = {
            t: 'encrypted';
            c: string; // Base64 encoded encrypted content
        };

        // Update content types
        type UpdateBody = {
            t: 'new-message';
            sid: string;
            message: {
                id: string;
                seq: number;
                content: SessionMessageContent;
                localId: string | null;
                createdAt: number;
                updatedAt: number;
            }
        } | {
            t: 'new-session';
            id: string;
            seq: number;
            metadata: string;
            metadataVersion: number;
            agentState: string | null;
            agentStateVersion: number;
            active: boolean;
            activeAt: number;
            createdAt: number;
            updatedAt: number;
        } | {
            t: 'update-session'
            id: string;
            metadata?: {
                value: string;
                version: number;
            } | null | undefined
            agentState?: {
                value: string;
                version: number;
            } | null | undefined
        };
    }
}

// The file MUST be a module! 
export { };