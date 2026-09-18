import type { AgentProfile } from '../group-chat/profiles.js';
import type { RoomAgentSnapshot } from '../group-chat/rooms.js';

/** Identity presentation follows the current library profile; execution fields remain frozen in the room snapshot. */
export function displayAvatarId(member: Pick<RoomAgentSnapshot, 'id' | 'avatarId'>, profiles: readonly Pick<AgentProfile, 'id' | 'avatarId'>[]): number {
  return profiles.find(profile => profile.id === member.id)?.avatarId ?? member.avatarId;
}
