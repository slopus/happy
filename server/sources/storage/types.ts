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
                createdAt: number;
                updatedAt: number;
            }
        } | {
            t: 'new-session';
            id: string;
            seq: number;
            metadata: string;
            active: boolean;
            activeAt: number;
            createdAt: number;
            updatedAt: number;
        };
    }
}

// The file MUST be a module! 
export { };