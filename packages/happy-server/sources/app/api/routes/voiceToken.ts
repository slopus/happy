export type ElevenLabsTokenResponse = {
    token: string;
    conversation_id?: string;
};

/**
 * New ElevenLabs responses expose conversation_id directly. The JWT fallback
 * keeps compatibility with older deployments whose LiveKit room carried it.
 */
export function resolveVoiceConversationId(response: ElevenLabsTokenResponse): string | null {
    if (response.conversation_id) return response.conversation_id;

    try {
        const payload = response.token.split('.')[1];
        if (!payload) return null;
        const jwtPayload = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
            video?: { room?: unknown };
        };
        const room = jwtPayload.video?.room;
        if (typeof room !== 'string') return null;
        return room.match(/(conv_[a-zA-Z0-9]+)/)?.[0] ?? null;
    } catch {
        return null;
    }
}
