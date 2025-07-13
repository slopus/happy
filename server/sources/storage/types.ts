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
            mid: string;
            c: string; // The encrypted content from the message
        };
    }
}

// The file MUST be a module! 
export { };