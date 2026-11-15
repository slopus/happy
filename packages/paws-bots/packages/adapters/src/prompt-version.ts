import { createHash } from "node:crypto";
import { FLEET_WRITE_TOOL_NAMES, RUN_TRIGGERS } from "@rakazo/contracts";
import {
  messagingChannelPrivacyBlock,
  messagingDmSurfaceNote,
  nonOwnerChatPrivacyBlock,
} from "@rakazo/core";
import { builtinAgentTools } from "./builtin-tools.js";
import { teamWorkspaceInstruction } from "./computer-support.js";
import { HISTORY_FORMAT_VERSION } from "./pi-runtime-history.js";
import { messageToAgentHistoryText } from "./reply-context.js";
import {
  botEmailInstruction,
  COMPUTER_USE_INSTRUCTION,
  dockerComputerToolInstruction,
  hostComputerInstruction,
  PRIVATE_WORKSPACE_INSTRUCTION,
  persistentComputerInstruction,
  runIdentityInstruction,
  userTurnInstructions,
  voiceCallInstruction,
} from "./run-instructions.js";
import { GROUP_UNADDRESSED_REPLY_GUIDANCE, runReplyGuidance } from "./run-replies.js";
import { CONTEXT_POLICY_SETTINGS } from "./runtime-context.js";
import { TASK_CATALOG_GUIDANCE } from "./task-catalog.js";

/**
 * Everything we change when tuning a bot's behavior, rendered from fixed placeholders: the system
 * prompt templates with every built-in tool offered and with none, the built-in tool descriptions,
 * the reply-quote format, the history replay format version and the context policy. Never reads user data, so it is the same on every run
 * of one release.
 */
export function promptVersionParts() {
  const bot = { name: "Bot", description: "Helps.", instructions: "Do the job." };
  const allTools = new Set(builtinAgentTools.map((tool) => tool.name));
  const toolSets = [undefined, allTools];
  const host = { home: "/home", shell: "sh", platform: "linux" };
  return {
    historyFormat: HISTORY_FORMAT_VERSION,
    context: CONTEXT_POLICY_SETTINGS,
    tools: builtinAgentTools.map((tool) => [tool.name, tool.description, tool.inputSchema]),
    computerUse: COMPUTER_USE_INSTRUCTION,
    computers: toolSets.flatMap((disabled) =>
      [true, false].flatMap((heldForTakeover) =>
        [true, false].flatMap((graphicalToolsAllowed) =>
          [true, false].map((graphical) =>
            persistentComputerInstruction({
              heldForTakeover,
              graphicalToolsAllowed,
              graphical,
              disabled,
            }),
          ),
        ),
      ),
    ),
    hosts: ["wuying", "local"].map((kind) => hostComputerInstruction(kind, host)),
    dockerComputer: toolSets.map((disabled) => dockerComputerToolInstruction("docker", disabled)),
    workspaces: [PRIVATE_WORKSPACE_INSTRUCTION, teamWorkspaceInstruction("bot")],
    taskCatalog: TASK_CATALOG_GUIDANCE,
    messaging: [
      messagingDmSurfaceNote(),
      messagingChannelPrivacyBlock(),
      nonOwnerChatPrivacyBlock(),
    ],
    voiceCall: toolSets.map((disabled) => voiceCallInstruction(disabled)),
    identity: ["user", "created"].map((trigger) => runIdentityInstruction(bot, trigger)),
    email: botEmailInstruction("bot@example.com", { read: true, send: true, delete: true }),
    groupReply: GROUP_UNADDRESSED_REPLY_GUIDANCE,
    replies: [
      ...RUN_TRIGGERS.map((trigger) => runReplyGuidance(trigger)),
      runReplyGuidance("user", "messages"),
    ],
    replyQuote: messageToAgentHistoryText({
      id: "m2",
      threadId: "t",
      role: "user",
      blocks: [{ kind: "text", text: "Reply." }],
      replyTo: { id: "m1", threadId: "t", role: "bot", blocks: [{ kind: "text", text: "Hi." }] },
    }),
    instructions: toolSets.flatMap((disabledBuiltinTools) =>
      (["connected", "offline"] as const).map((userComputer) =>
        userTurnInstructions({
          botInstructions: "",
          groupContext: undefined,
          messagingContext: undefined,
          redactedMemoryContext: undefined,
          redactedScratchpadContext: undefined,
          hasHistoricalContext: true,
          historyRetrievalEnabled: true,
          computerInstruction: "",
          pageBrowserAllowed: true,
          workspaceInstruction: "",
          agentEnvironmentInstruction: undefined,
          botDirectory: undefined,
          pluginLine: undefined,
          agentSkillsLine: "Skills.",
          taughtSkillsLine: undefined,
          replyGuidance: runReplyGuidance("user"),
          disabledBuiltinTools,
          offeredFleetTools: FLEET_WRITE_TOOL_NAMES,
          followUpsOffered: true,
          backgroundHelpersAllowed: true,
          userComputer,
        }),
      ),
    ),
  };
}

export function promptVersionOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

let cached: string | undefined;

/**
 * Stored on each run, so outcomes can be compared between prompt and replay versions. Computed on
 * first use rather than at import: some tool descriptions read settings the entry point loads
 * after its imports run, and reading them early would fix the wrong text in place.
 */
export function promptVersion(): string {
  cached ??= promptVersionOf(promptVersionParts());
  return cached;
}
