import type { MachineMetadata } from '@/api/types';

/*
 * Only engines that can do *both* halves: register the channel RPCs, and produce an
 * authoritative final answer the channel may relay.
 *
 * `grok` (and every other ACP agent) registers the RPCs but is deliberately absent. ACP's
 * `AgentMessage` model output carries only `textDelta`/`fullText` — no phase, no final marker —
 * and `AcpBackend.sendPrompt` discards the `PromptResponse` whose `stopReason` is the one
 * authoritative terminal it does receive. Without a per-segment final marker there is no way to
 * tell an answer from commentary, and R14 does not allow guessing, so ACP is unsupported rather
 * than approximately supported. See the spec notes for the concrete work that would change it.
 */
/*
 * Two different questions, and only one of them has its own list.
 *
 * `engines` is who can execute an external channel turn — and, because a runtime that executes
 * one also publishes its approval waits, it is equally the set that emits `channel-permission`
 * with `kind: 'desktop-only'` (R8/R9). Both Claude and Codex do; Gemini and the ACP handler do
 * neither, which is why they are absent.
 *
 * `approvals.engines` is the narrower question: who can have a prompt *answered* from a
 * messenger. Only Claude. The prompt→turn binding, the one-shot consume and the dedicated
 * `channel-permission` RPC live in the Claude launcher's ordered queue
 * (`claude/claudeRemoteLauncher.ts` + `channel/channelPermissionWiring.ts`). Codex reaches its
 * approvals through `codexAppServerClient`'s own request/response methods, registers no
 * dedicated RPC, and binds every observed prompt as unanswerable — so listing it here would
 * advertise a button whose answers have no route.
 */
export const CHANNEL_SUPPORT_CAPABILITY: NonNullable<MachineMetadata['channelSupport']> = {
  protocolVersion: 1,
  engines: ['claude', 'codex'],
  approvals: { protocolVersion: 1, engines: ['claude'] },
};
