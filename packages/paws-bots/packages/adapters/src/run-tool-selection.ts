import {
  disabledBuiltinToolSet,
  FLEET_TOOL_NAMES,
  FLEET_WRITE_TOOL_NAMES,
} from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, isBackgroundRunTrigger, isOwnerStartedRun } from "@rakazo/core";
import { builtinAgentTools } from "./builtin-tools.js";
import { selectCloudAgentTools } from "./cloud-agent-tools-select.js";
import { selectMemoryTools } from "./memory-tools.js";
import { filterImageReturningComputerTools } from "./model-vision.js";
import { USER_COMPUTER_SCREEN_TOOLS } from "./run-tools-user-computer.js";
import {
  filterBuiltinToolsForRun,
  filterBuiltinToolsForThread,
  SCHEDULE_TOOL_NAMES,
} from "./schedule-tools.js";
import { SKILL_TOOL_NAMES } from "./skill-tools.js";

export const READ_ONLY_AGENT_TOOLS = new Set([
  "computer_observe",
  "list_files",
  "list_fleet",
  "read_file",
  "read_history",
  "read_email",
  "search_history",
  "request_takeover",
  "run_subagent",
  "task_catalog",
  "recall_memory",
  "reflect_memory",
  "schedule_list",
  "scratchpad_list",
  "board_tickets",
  "ticket_get",
  "skill_read",
  "web_search",
  "web_fetch",
  "service_search",
  "browser_snapshot",
  "list_secrets",
  "cloud_agent_status",
  "purchase_status",
]);

/** The bot's own inbox, offered only in its owner's runs outside groups and channels. */
const EMAIL_INBOX_TOOL_NAMES = new Set(["read_email", "delete_email"]);
const PAID_SERVICE_TOOL_NAMES = new Set(["service_search", "service_call"]);

/** Offered only to a user who connected a wallet. */
const PURCHASE_TOOL_NAMES = new Set(["request_purchase", "purchase_status", "paid_request"]);

export const BUILTIN_AGENT_TOOL_NAMES = new Set(builtinAgentTools.map((tool) => tool.name));

const FLEET_TOOL_NAMES_SET: ReadonlySet<string> = new Set(FLEET_TOOL_NAMES);

export const FLEET_WRITE_TOOL_NAMES_SET: ReadonlySet<string> = new Set(FLEET_WRITE_TOOL_NAMES);

/**
 * The creation intro asks what the bot is for and records the answer on its own profile.
 * It must not act (shell, computer, scheduling, spawning another bot, ...) before the user
 * has said what it is for. Answering its question resumes it as the user's turn, with
 * every tool (see commitAnswerRunInput).
 */
const CREATED_RUN_TOOL_NAMES = new Set(["ask_user", "update_bot"]);

/**
 * A background helper works while the bot keeps talking, so it only reads and looks things up:
 * no computer (the bot's own turns keep it), no questions to the user, and no changes to
 * memory, skills or routines, which the bot makes itself when the result comes back.
 */
export const BACKGROUND_HELPER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search",
  "web_fetch",
  "recall_memory",
  "reflect_memory",
  "skill_read",
  "task_catalog",
  "scratchpad_list",
  "board_tickets",
  "ticket_get",
  "cloud_agent_status",
]);

/** Cross-owner agent connections only exist for chat-linked bots, in turns that can talk. */
export function offersAgentConnectionTools(options: {
  hasMessagingIdentity: boolean;
  crossSpaceCommunication: boolean;
  trigger: string;
}): boolean {
  return (
    options.hasMessagingIdentity &&
    options.crossSpaceCommunication &&
    !isBackgroundRunTrigger(options.trigger) &&
    options.trigger !== "created" &&
    options.trigger !== BACKGROUND_HELPER_TRIGGER
  );
}

export function selectBuiltinToolsForRun(options: {
  ticketBoardEnabled?: boolean;
  phoneCallsEnabled?: boolean;
  historyRetrievalEnabled?: boolean;
  graphicalToolsAllowed: boolean;
  /** Page browser tools need a graphical computer (Chrome), not model vision. */
  pageBrowserAllowed?: boolean;
  groupId: string | null;
  trigger: string;
  semanticMemoryEnabled: boolean;
  /** The configured provider can forget individual facts. */
  semanticMemoryForgets?: boolean;
  /** The configured provider can answer a question from many memories. */
  semanticMemoryReflects?: boolean;
  cloudAgentEnabled?: boolean;
  cloudAgentCleanupEnabled?: boolean;
  /** The run's user connected a payment wallet. */
  paymentWalletEnabled?: boolean;
  mediaImagesEnabled?: boolean;
  mediaVideoEnabled?: boolean;
  /** The deployment configured paid data services. */
  paidServicesEnabled?: boolean;
  messagingChannelRun: boolean;
  /** Hanging up is only offered to a turn the caller spoke on a live call. */
  voiceCall?: boolean;
  /** Built-in names this bot turned off. Unknown names are ignored. */
  disabledBuiltinTools?: readonly string[];
  fleetManagement?: boolean;
  /** A follow-up run whose source message the user wrote. */
  followUpFromUser?: boolean;
  /** The person who started this run has their desktop connected (see userComputerOwner). */
  userComputer?: boolean;
  /** Their connected desktop can look at and drive its apps. */
  userComputerScreen?: boolean;
  /** The bot has an email address and this run is its owner's own, outside any group or channel. */
  emailInbox?: boolean;
  /** This server receives email and the bot has no address yet. */
  emailClaimable?: boolean;
  /** The inbox may be read and this server can send email. */
  emailSend?: boolean;
}) {
  const disabled = disabledBuiltinToolSet(options.disabledBuiltinTools);
  const ownerStartedRun = isOwnerStartedRun(options.trigger, Boolean(options.followUpFromUser));
  // Claiming is offered only in the owner's own chat, so once the bot claims an address there it
  // can read the mail that follows, such as a sign-up code, in the same run.
  const emailClaimOffered =
    Boolean(options.emailClaimable) &&
    ownerStartedRun &&
    !options.groupId &&
    !options.messagingChannelRun;
  const emailMailbox = Boolean(options.emailInbox) || emailClaimOffered;
  return selectCloudAgentTools(
    selectMemoryTools(
      filterBuiltinToolsForRun(
        filterBuiltinToolsForThread(
          filterPageBrowserTools(
            filterImageReturningComputerTools(builtinAgentTools, options.graphicalToolsAllowed),
            options.pageBrowserAllowed ?? options.graphicalToolsAllowed,
          ),
          options.groupId,
        ),
        options.trigger,
      ),
      options.semanticMemoryEnabled,
      Boolean(options.semanticMemoryForgets),
      Boolean(options.semanticMemoryReflects),
    ),
    Boolean(options.cloudAgentEnabled),
    Boolean(options.cloudAgentCleanupEnabled),
  ).filter(
    (tool) =>
      !disabled.has(tool.name) &&
      (options.trigger !== "created" || CREATED_RUN_TOOL_NAMES.has(tool.name)) &&
      (options.trigger !== BACKGROUND_HELPER_TRIGGER ||
        BACKGROUND_HELPER_TOOL_NAMES.has(tool.name)) &&
      (!FLEET_TOOL_NAMES_SET.has(tool.name) ||
        (Boolean(options.fleetManagement) && ownerStartedRun)) &&
      (ownerStartedRun || (tool.name !== "update_preferences" && tool.name !== "feedback")) &&
      (options.paymentWalletEnabled || !PURCHASE_TOOL_NAMES.has(tool.name)) &&
      (options.mediaImagesEnabled || tool.name !== "generate_image") &&
      (options.mediaVideoEnabled || tool.name !== "generate_video") &&
      (options.paidServicesEnabled || !PAID_SERVICE_TOOL_NAMES.has(tool.name)) &&
      (options.ticketBoardEnabled ||
        (tool.name !== "board_tickets" && !tool.name.startsWith("ticket_"))) &&
      (!isBackgroundRunTrigger(options.trigger) ||
        ![
          "message_user",
          "message_bot",
          "handoff_to_bot",
          "message_agent",
          "generate_image",
          "generate_video",
        ].includes(tool.name)) &&
      (options.voiceCall || tool.name !== "end_call") &&
      (emailMailbox || !EMAIL_INBOX_TOOL_NAMES.has(tool.name)) &&
      ((emailMailbox && options.emailSend) || tool.name !== "send_email") &&
      (emailClaimOffered || tool.name !== "claim_email_address") &&
      (options.userComputer || tool.name !== "user_computer_shell") &&
      (options.userComputerScreen || !USER_COMPUTER_SCREEN_TOOLS.has(tool.name)) &&
      // Already on a call, or reached through a messaging channel that cannot ring.
      ((options.phoneCallsEnabled &&
        !options.groupId &&
        !options.voiceCall &&
        !options.messagingChannelRun &&
        !isBackgroundRunTrigger(options.trigger)) ||
        tool.name !== "call_user") &&
      (options.historyRetrievalEnabled ||
        !["search_history", "read_history"].includes(tool.name)) &&
      (!options.messagingChannelRun ||
        (!SCHEDULE_TOOL_NAMES.has(tool.name) &&
          !SKILL_TOOL_NAMES.has(tool.name) &&
          ![
            "remember",
            "save_shared_memory",
            "save_memory",
            "recall_memory",
            "forget_memory",
            "reflect_memory",
            "task_catalog",
            "board_tickets",
          ].includes(tool.name) &&
          !tool.name.startsWith("scratchpad_") &&
          !tool.name.startsWith("ticket_"))),
  );
}

export const PAGE_BROWSER_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
]);

export function filterPageBrowserTools<T extends { name: string }>(
  tools: T[],
  pageBrowserAllowed: boolean,
): T[] {
  if (pageBrowserAllowed) return tools;
  return tools.filter((tool) => !PAGE_BROWSER_TOOL_NAMES.has(tool.name));
}

/** The fleet tools this run was offered, the same decision as tool selection. */
export function offeredFleetTools(tools: readonly { name: string }[]): string[] {
  return tools.map((tool) => tool.name).filter((name) => FLEET_TOOL_NAMES_SET.has(name));
}

const FOLLOW_UP_TOOL_NAMES = [
  "scratchpad_add",
  "scratchpad_complete",
  "schedule_create",
  "schedule_cancel",
];

/**
 * Whether this run can set its own follow-ups. Only a run the owner started can tell what is
 * still open with them; routines, webhooks, channels, subagents and hand-offs from other bots
 * are not, and some of them would need approval for every schedule.
 */
export function followUpsOffered(
  tools: readonly { name: string }[],
  ownerStartedRun: boolean,
): boolean {
  return (
    ownerStartedRun &&
    FOLLOW_UP_TOOL_NAMES.every((name) => tools.some((tool) => tool.name === name))
  );
}
