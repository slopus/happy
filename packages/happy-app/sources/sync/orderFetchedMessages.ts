/**
 * History pages come back newest first (`before_seq` fetches are ordered
 * `seq desc`), but the reducer links a subagent's messages to their Agent
 * tool call only if it has already seen that call. Fed newest first, the
 * subagent messages arrive before their parent, are kept as standalone
 * messages, and the Agent call ends up with no children — an empty subagent
 * page. Applying each page oldest first keeps parents ahead of children.
 */
export function orderFetchedMessages<T extends { seq: number }>(messages: readonly T[]): T[] {
    return [...messages].sort((a, b) => a.seq - b.seq);
}
