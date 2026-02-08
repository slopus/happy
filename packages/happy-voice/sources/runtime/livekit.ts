import { randomBytes } from 'node:crypto';
import { DataPacket_Kind } from '@livekit/protocol';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import { env } from './env';
import { logWarn } from './log';

const roomServiceClient = new RoomServiceClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
);

const dispatchClient = new AgentDispatchClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
);

export function buildRoomName() {
    return `happy_voice_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function buildParticipantIdentity() {
    return `human_${randomBytes(6).toString('hex')}`;
}

export async function ensureRoom(roomName: string) {
    try {
        await roomServiceClient.createRoom({
            name: roomName,
            emptyTimeout: env.LIVEKIT_ROOM_TTL_SECONDS,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Room already exists race is safe to ignore.
        if (!message.toLowerCase().includes('already exists')) {
            throw error;
        }
    }
}

export async function dispatchAgent(roomName: string, metadata: string) {
    return dispatchClient.createDispatch(roomName, env.LIVEKIT_AGENT_NAME, { metadata });
}

export async function buildParticipantToken(roomName: string, participantIdentity: string) {
    const accessToken = new AccessToken(
        env.LIVEKIT_API_KEY,
        env.LIVEKIT_API_SECRET,
        {
            identity: participantIdentity,
            ttl: `${env.LIVEKIT_TOKEN_TTL_SECONDS}s`,
        },
    );

    accessToken.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
    });

    return accessToken.toJwt();
}

export async function deleteRoom(roomName: string) {
    try {
        await roomServiceClient.deleteRoom(roomName);
    } catch (error) {
        logWarn('Failed to delete room', { roomName, error });
    }
}

export async function sendRoomData(roomName: string, topic: string, payload: Record<string, unknown>) {
    const data = new TextEncoder().encode(JSON.stringify(payload));
    await roomServiceClient.sendData(
        roomName,
        data,
        DataPacket_Kind.RELIABLE,
        { topic },
    );
}
