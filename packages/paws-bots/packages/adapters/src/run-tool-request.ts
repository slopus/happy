import type { ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import { BOT_INSTRUCTIONS_MAX_LENGTH, BotSecretAuth, OneTimeCodeTarget } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { runLoginKind } from "@rakazo/db";
import { prepareAgentConnectionResponse } from "./agent-connections.js";
import type { FleetCardSummary } from "./approval-ask.js";
import type { TerminatingToolResult } from "./approval-effect.js";
import {
  approvalReplayPathError,
  approvalReplayResourceError,
  approvalRoutesMatch,
  approvedCatalogReplay,
  approvedReplayArgs,
  boundDirectApprovalDetails,
  boundDirectApprovalRequest,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
  catalogApprovalMatchesLiveRoute,
  catalogApprovalRequest,
} from "./approval-effect.js";
import { listVaultItems } from "./bot-secrets.js";
import { validCloudAgentArgs } from "./cloud-agent-tools.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { isFleetApprovalTool, modelLabel, prepareFleetRequest } from "./fleet-tools.js";
import { assertConnectorToolArgs, CATALOG_EXECUTE } from "./lazy-tool-catalog.js";
import { paidRequestEffect, restorePaidRequest } from "./paid-request.js";
import type { PurchaseApproval } from "./purchase-gate.js";
import {
  detectPurchase,
  PURCHASE_CHECKED_TOOLS,
  purchaseApprovalOf,
  purchaseCardSummary,
} from "./purchase-gate.js";
import type { RunContext } from "./run-context.js";
import {
  isRunTainted,
  neverAsks,
  OWN_INSTRUCTIONS_BASELINE_UNKNOWN_ERROR,
  refuseOwnerSettingsChange,
} from "./run-context.js";
import {
  approvalReplayEffectToolName,
  CATALOG_APPROVAL_TOOL,
  isSubagentToolExecution,
} from "./run-effects.js";
import { fleetPrepareDeps } from "./run-model.js";
import { BUILTIN_AGENT_TOOL_NAMES, FLEET_WRITE_TOOL_NAMES_SET } from "./run-tool-selection.js";
import { holdSharedPageSave } from "./run-tools-pages.js";
import { scheduleCreateRefusal } from "./run-tools-tasks.js";
import { USER_COMPUTER_TOOLS } from "./run-tools-user-computer.js";
import { SCHEDULE_TOOL_NAMES } from "./schedule-tools.js";
import { SKILL_TOOL_NAMES } from "./skill-tools.js";
import { refusal } from "./tool-refusal.js";
import { argumentGiven, dropUnchangedOwnBotArgs } from "./update-bot-patch.js";
import type { VaultCardUse, VaultLoginUse } from "./vault-card-use.js";
import {
  cardUseSummary,
  loginUseSummary,
  requestedCardUse,
  requestedLoginFills,
  vaultCardUseOf,
  vaultLoginUseOf,
} from "./vault-card-use.js";

/** A tool call resolved to the tool it runs and the exact request an approval covers. */
export interface ToolRequest {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
  connectorCall: ConnectorCall;
  /** The persisted request an approval covers; catalog and bound routes wrap the args. */
  effectRequest: unknown;
  /** The connector tool a catalog call resolved to. */
  resolvedTool: ConnectorTool | undefined;
  catalogRemapped: boolean;
  /** The approved effect this attempt must replay next, if any. */
  nextApprovedTool: string | undefined;
  approvedEffectKey: string | undefined;
  replayEffectToolName: string;
  fleetSummary: FleetCardSummary | undefined;
  /** Gated like a consequential action, even when the tool alone is not. */
  heldForApproval: boolean;
  /** This page tool call completes a purchase, which a person approves each time. */
  purchase: PurchaseApproval | undefined;
  /** This page tool call types a saved card into a checkout, which a person approves each time. */
  cardUse: VaultCardUse | undefined;
  /** This browser_act call signs in with a saved login that asks first, approved like a card. */
  loginUse: VaultLoginUse | undefined;
}

type ToolError = { error: string };

/** A prepare-step refusal: a plain error, or a result that ends the turn on a repeat. */
type PrepareRefusal = ToolError | TerminatingToolResult;

/**
 * Resolve catalog and bound connector routes, and line the call up with the next approved
 * effect this attempt must replay.
 */
export async function resolveToolRequest(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
): Promise<ToolRequest | ToolError> {
  const { deps, context } = ctx;
  const approvedReplays = ctx.tools.approvedReplays;
  let connectorCall: ConnectorCall = {
    tool: name,
    args,
    executionId,
    route: ctx.tools.connector.get(name)?.route,
  };
  const onCatalogExecuteRoute = Boolean(
    connectorCall.route &&
      !connectorCall.route.resourceId &&
      connectorCall.route.toolName === CATALOG_EXECUTE,
  );
  const approvedReplay = approvedCatalogReplay(
    approvedReplays,
    name,
    CATALOG_APPROVAL_TOOL,
    onCatalogExecuteRoute,
  );
  if (approvedReplay.error) return { error: approvedReplay.error };
  if (approvedReplay.args) connectorCall.args = approvedReplay.args;
  let catalogRemapped = false;
  let resolvedTool: ConnectorTool | undefined;
  if (name.startsWith("cloud_agent_") && !validCloudAgentArgs(name, args)) {
    return refusal(
      "invalid_cloud_agent_arguments",
      "Invalid cloud agent arguments. Raw environment variables are not supported.",
    );
  }
  let effectRequest: unknown = name === "paid_request" ? paidRequestEffect(args) : args;
  if (connectorCall.route && deps.connector?.resolveCall) {
    try {
      const resolved = await deps.connector.resolveCall(connectorCall, context);
      if (resolved) {
        if (BUILTIN_AGENT_TOOL_NAMES.has(resolved.tool.name)) {
          return refusal(
            "connector_name_conflict",
            "Connector tool name conflicts with a built-in tool",
          );
        }
        name = resolved.tool.name;
        args = resolved.call.args;
        catalogRemapped = true;
        resolvedTool = resolved.tool;
        effectRequest = catalogApprovalRequest(
          connectorCall.tool,
          connectorCall.args,
          CATALOG_APPROVAL_TOOL,
          resolved.tool.route?.resourceId &&
            resolved.tool.route.connectorId &&
            resolved.tool.route.toolName
            ? {
                connectorId: resolved.tool.route.connectorId,
                resourceId: resolved.tool.route.resourceId,
                resourceRevision: resolved.tool.route.resourceRevision,
                connectionId: resolved.tool.route.connectionId,
                toolName: resolved.tool.route.toolName,
              }
            : undefined,
        );
        connectorCall = resolved.call;
      }
    } catch (error) {
      return { error: sanitizeConnectorError(error) };
    }
  }
  if (approvedReplay.args && !catalogRemapped) {
    return refusal(
      "approved_catalog_request_unresolved",
      "Approved catalog request could not be resolved to a tool. Deny and retry the direct tool call.",
    );
  }
  if (
    !catalogRemapped &&
    connectorCall.route?.resourceId &&
    connectorCall.route.connectorId &&
    connectorCall.route.toolName
  ) {
    effectRequest = boundDirectApprovalRequest(
      {
        connectorId: connectorCall.route.connectorId,
        resourceId: connectorCall.route.resourceId,
        resourceRevision: connectorCall.route.resourceRevision,
        connectionId: connectorCall.route.connectionId,
        toolName: connectorCall.route.toolName,
      },
      args,
      CATALOG_APPROVAL_TOOL,
    );
  }
  // Approval applies to the exact persisted request, never to a payload the model
  // reconstructs after the worker resumes. This also makes a changed reconstruction
  // hit the already-approved effect instead of creating a second approval card.
  const nextApprovedTool = approvedReplays.nextToolName();
  let approvedEffectKey: string | undefined;
  const nextApprovedRequest = approvedReplays.nextRequest();
  const liveRoute =
    connectorCall.route?.resourceId &&
    connectorCall.route.connectorId &&
    connectorCall.route.toolName
      ? {
          connectorId: connectorCall.route.connectorId,
          resourceId: connectorCall.route.resourceId,
          resourceRevision: connectorCall.route.resourceRevision,
          connectionId: connectorCall.route.connectionId,
          toolName: connectorCall.route.toolName,
        }
      : undefined;
  const nextBound = boundDirectApprovalDetails(nextApprovedRequest, CATALOG_APPROVAL_TOOL);
  const nextCatalog = catalogApprovalDetails(nextApprovedRequest, CATALOG_APPROVAL_TOOL);
  // After collision uniquify, the live tool name may differ from the stored effect
  // kind while still targeting the same bound connector resource.
  const sameBoundResource = Boolean(
    nextBound && liveRoute && approvalRoutesMatch(nextBound.route, liveRoute),
  );
  // After catalog shrink, a catalog approval may resume as the matching direct tool.
  const sameCatalogTarget = Boolean(
    nextCatalog && catalogApprovalMatchesLiveRoute(nextCatalog, liveRoute),
  );
  if (nextApprovedTool && nextApprovedTool !== name && !sameBoundResource && !sameCatalogTarget) {
    return refusal(
      "approved_request_not_replayed",
      `Approved request ${nextApprovedTool} must be replayed before ${name}.`,
    );
  }
  // Drain FIFO only when the pending approval matches this path (catalog vs direct).
  const replayEffectToolName = approvalReplayEffectToolName(
    name,
    nextApprovedTool,
    sameBoundResource || sameCatalogTarget,
  );
  if (nextApprovedTool && (nextApprovedTool === name || sameBoundResource || sameCatalogTarget)) {
    const pathError = approvalReplayPathError(
      name,
      catalogRemapped,
      nextApprovedRequest,
      CATALOG_APPROVAL_TOOL,
      liveRoute,
    );
    if (pathError) return { error: pathError };
    const resourceError = approvalReplayResourceError(
      name,
      catalogRemapped,
      nextApprovedRequest,
      liveRoute,
      CATALOG_APPROVAL_TOOL,
    );
    if (resourceError) return { error: resourceError };
    approvedEffectKey = approvedReplays.nextIdempotencyKey();
    const approvedRequest = approvedReplays.take(nextApprovedTool)!;
    const approvedCatalog = catalogApprovalDetails(approvedRequest, CATALOG_APPROVAL_TOOL);
    if (approvedCatalog && !catalogRemapped) {
      // Shrink-to-direct: restore approved inner arguments, not the wrapper envelope.
      const innerArgs = catalogApprovalInnerArgs(approvedCatalog);
      if (!innerArgs) {
        return refusal(
          "approved_catalog_request_missing_arguments",
          `Approved catalog request ${name} is missing tool arguments.`,
        );
      }
      args = innerArgs;
    } else {
      // Catalog wrappers keep resolveCall's parsed args so Zod stripping/coercion
      // still matches the first-approval effect key and execute payload.
      const live = args;
      args = approvedReplayArgs(approvedRequest, args, CATALOG_APPROVAL_TOOL);
      if (name === "paid_request") {
        const restored = restorePaidRequest(args, live);
        if ("error" in restored && typeof restored.error === "string")
          return { error: restored.error };
        args = restored;
      }
    }
    // Bound / shrink-direct approvals may skip catalog parse — reject before execute
    // if they no longer match the live schema.
    if (
      boundDirectApprovalDetails(approvedRequest, CATALOG_APPROVAL_TOOL) ||
      (approvedCatalog && !catalogRemapped)
    ) {
      const liveSchema = (resolvedTool ?? ctx.tools.connector.get(name))?.inputSchema;
      if (liveSchema) {
        try {
          assertConnectorToolArgs(liveSchema, args);
        } catch (error) {
          return { error: sanitizeConnectorError(error) };
        }
      }
    }
  }
  return {
    name,
    args,
    executionId,
    connectorCall,
    effectRequest,
    resolvedTool,
    catalogRemapped,
    nextApprovedTool,
    approvedEffectKey,
    replayEffectToolName,
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: undefined,
  };
}

/**
 * The saved login that asks first this browser_act call fills: every field it fills, on the one
 * of its sites it fills there, as saved now. A replay keeps the approval the user answered.
 */
async function askingLoginUse(
  ctx: RunContext,
  actions: unknown,
  /** The user's answer this call replays; its approval for a login, if any, is `given`. */
  replay: boolean,
  given: unknown,
): Promise<VaultLoginUse | ToolError | undefined> {
  const { deps, run } = ctx;
  const asking: VaultLoginUse[] = [];
  for (const [login, fields] of requestedLoginFills(actions)) {
    // This run's login that wasn't saved is what the person just typed, and is filled instead.
    const kind = runLoginKind(run.id, login);
    if (
      await deps.prisma.secret.count({ where: { userId: run.userId, spaceId: run.spaceId, kind } })
    )
      continue;
    // A login's title never comes from its value, so it isn't decrypted here.
    const [item] = await listVaultItems(deps.prisma, deps.secretStore, run, login, false);
    if (item?.policy !== "ask" || BotSecretAuth.safeParse(item.auth).data?.type !== "login")
      continue;
    const savedAt = item.updatedAt.toISOString();
    // Where it fills: the page's site when that is one of its others, as the fill reads it.
    const url = ctx.state.pageUrl;
    const page = url && URL.canParse(url) ? new URL(url).origin : "";
    const site = item.alsoOn?.includes(page) ? page : item.origin;
    // Saved where no approval can name, as under older rules, it is never typed: the fill refuses.
    if (![item.origin, site].every((origin) => OneTimeCodeTarget.safeParse({ origin }).success))
      continue;
    asking.push({
      kind: "login",
      login,
      site,
      title: item.title,
      fields,
      savedAt,
    });
  }
  const [wanted] = asking;
  if (!wanted) return undefined;
  if (asking.length > 1)
    return { error: "Sign in with one saved login that asks first per browser_act call." };
  const approved = replay ? vaultLoginUseOf(given) : undefined;
  if (!approved && !replay) return wanted;
  // An answer given for something else, such as before the login asked first, never covers it.
  if (!approved)
    return {
      error:
        "This signs in with a saved login the user has not approved, so nothing was typed. Call the tool again; that asks the user.",
    };
  if (approved.login !== wanted.login || approved.fields.join("\n") !== wanted.fields.join("\n"))
    return {
      error:
        "This signs in with a saved login the user has not approved for these fields, so nothing was typed. Call the tool again; that asks the user.",
    };
  return approved;
}

/**
 * Check bot-management and instruction-proposal preconditions, and canonicalize the
 * requests whose approval card shows resolved names. Updates the request in place.
 */
export async function prepareToolRequest(
  ctx: RunContext,
  request: ToolRequest,
): Promise<PrepareRefusal | undefined> {
  const { deps, run, bot } = ctx;
  const { name, executionId, nextApprovedTool } = request;
  let { args } = request;
  if (
    (SCHEDULE_TOOL_NAMES.has(name) || SKILL_TOOL_NAMES.has(name)) &&
    (ctx.source.messagingChannelRun ||
      (await deps.prisma.steeringMessage.findFirst({
        where: {
          runId: ctx.runId,
          claimedAt: { not: null },
          message: { blocks: { array_contains: [{ kind: "channel_message" }] } },
        },
        select: { id: true },
      })))
  ) {
    return refusal(
      "shared_channel_tool_unavailable",
      "This tool is unavailable after a shared-channel message.",
    );
  }
  // Before the gate, so a run that may never reach the user's computer shows no approval card.
  if (USER_COMPUTER_TOOLS.has(name)) {
    if (!ctx.source.userComputerOwner || !deps.userDevices)
      return refusal(
        "user_computer_unavailable",
        "The user's computer is not available in this run.",
      );
    if (isSubagentToolExecution(executionId))
      return refusal("helper_user_computer", "Helpers cannot use the user's computer.");
  }
  // Before the gate, so a routine that cannot be saved shows no approval card. An approved
  // replay goes on to the handler, which checks again.
  if (name === "schedule_create" && nextApprovedTool !== name) {
    const refused = await scheduleCreateRefusal(ctx, args);
    if (refused) return refusal("schedule_create_refused", refused.error);
  }
  const fleetWrite =
    FLEET_WRITE_TOOL_NAMES_SET.has(name) ||
    name === "archive_bot" ||
    (name === "update_bot" && argumentGiven(args.bot_id));
  if (fleetWrite || name === "list_fleet") {
    if (isSubagentToolExecution(executionId))
      return refusal("helper_bot_management", "Helpers cannot use bot management tools.");
    // The run-start snapshot is not enough: the owner can turn the switch off mid-run.
    const live = await deps.prisma.bot.findUnique({
      where: { id: bot.id },
      select: { fleetManagement: true },
    });
    if (!live?.fleetManagement)
      return refusal("tool_disabled", "This tool is disabled for this bot.");
    if (!ctx.source.ownerStartedRun)
      return refusal("run_not_owner_started", "Bot management tools need a run you started.");
    if (fleetWrite && !(await neverAsks(ctx)) && (await ctx.trust.receivedOutsideMessage()))
      return refusal(
        "outside_message_blocks_bot_management",
        "Changes to the bots you manage are blocked for the rest of this run because it received a channel or webhook message.",
      );
  }
  if (name === "save_page") {
    const refused = await holdSharedPageSave(ctx, request);
    if (refused) return refused;
    args = request.args;
  }
  if (name === "update_bot" && !argumentGiven(args.bot_id)) {
    const refused = await prepareOwnBotUpdate(ctx, request);
    if (refused) return refused;
    args = request.args;
  }
  if (isFleetApprovalTool(name) && nextApprovedTool !== name) {
    // Resolve names, members, model and schedule now; an approved replay runs the stored
    // request above and never resolves them again.
    const prepared = await prepareFleetRequest(
      await fleetPrepareDeps(deps, run),
      ctx.fleetRun,
      name,
      args,
      ctx.secrets,
    );
    if (!prepared.ok) return refusal("bot_management_request_invalid", prepared.error);
    args = prepared.canonical;
    request.fleetSummary = prepared.summary;
  }
  if (name === "respond_agent_connection") {
    if (nextApprovedTool !== name) {
      const pending = await prepareAgentConnectionResponse(
        deps.prisma,
        bot.id,
        Boolean(args.accept),
      );
      if (!pending)
        return refusal("no_pending_connection_request", "no pending connection request");
      args = pending;
    } else if (
      typeof args.requester_name !== "string" ||
      typeof args.requester_address !== "string" ||
      typeof args.requester_provider !== "string"
    ) {
      return refusal("connection_request_not_pending", "connection request is no longer pending");
    }
  }
  if (PURCHASE_CHECKED_TOOLS.has(name)) {
    // The approval is written here from what the page says; a model-supplied one is dropped, and an
    // approved replay keeps the one the user saw.
    const {
      purchaseApproval: given,
      cardApproval: givenCard,
      loginApproval: givenLogin,
      ...rest
    } = args;
    const approved = nextApprovedTool === name ? purchaseApprovalOf(given) : undefined;
    args = approved ? { ...rest, purchaseApproval: given } : rest;
    // A saved card is typed only into the checkout a person approved: the approval names the card
    // and the site, and a replay keeps the one the user saw.
    const wantedCard = name === "browser_act" ? requestedCardUse(rest.actions) : undefined;
    if (wantedCard && "error" in wantedCard) return wantedCard;
    if (wantedCard) {
      const approvedCard = nextApprovedTool === name ? vaultCardUseOf(givenCard) : undefined;
      if (
        approvedCard &&
        (approvedCard.card !== wantedCard.card || approvedCard.site !== wantedCard.site)
      )
        return refusal(
          "card_not_approved",
          "This types a saved card the user has not approved, so nothing was typed. Call the tool again with only that card; that asks the user.",
        );
      let cardUse = approvedCard;
      if (!cardUse) {
        const [item] = await listVaultItems(deps.prisma, deps.secretStore, run, wantedCard.card);
        if (BotSecretAuth.safeParse(item?.auth).data?.type !== "card")
          return refusal("card_not_found", "No card is saved under this name. Check list_secrets.");
        cardUse = { ...wantedCard, title: item!.title, savedAt: item!.updatedAt.toISOString() };
      }
      args = { ...args, cardApproval: cardUse };
      request.cardUse = cardUse;
      request.fleetSummary = cardUseSummary(cardUse);
    }
    const loginUse =
      name === "browser_act"
        ? await askingLoginUse(ctx, rest.actions, nextApprovedTool === name, givenLogin)
        : undefined;
    if (loginUse && "error" in loginUse) return loginUse;
    if (loginUse && request.cardUse)
      return {
        error: "Type a saved card and sign in with a saved login in separate browser_act calls.",
      };
    // A desktop press has no check on the page right before it, as a browser_act click does: one the user
    // approved goes ahead only while the page still shows what the card did. A card that named nothing
    // (the check failed) has nothing to compare.
    if (
      name === "computer_act" &&
      approved &&
      (approved.site || approved.label || approved.amount)
    ) {
      const now = await detectPurchase(ctx, name, rest);
      if (
        !now ||
        now.site !== approved.site ||
        now.label !== approved.label ||
        now.amount === "?" ||
        now.total === "?" ||
        now.amount !== approved.amount ||
        (now.total ?? "") !== (approved.total ?? "")
      )
        return refusal(
          "purchase_page_changed",
          "The page changed since the user approved this purchase, so nothing was pressed. Look at the screen and try again.",
        );
    }
    const purchase = approved ?? (await detectPurchase(ctx, name, rest));
    // One card asks one question: a sign-in is never approved under a payment's.
    if (loginUse && purchase)
      return {
        error: "Sign in with a saved login and complete a purchase in separate browser_act calls.",
      };
    if (loginUse) {
      args = { ...args, loginApproval: loginUse };
      request.loginUse = loginUse;
      request.fleetSummary = loginUseSummary(loginUse);
    }
    // An approval given for something else never covers a purchase: the call is made again and asks.
    if (purchase && !approved && nextApprovedTool === name)
      return refusal(
        "purchase_not_approved",
        "This would complete a purchase, which the user has not approved, so nothing was pressed. Call the tool again with only that step; that asks the user.",
      );
    if (purchase) {
      args = { ...args, purchaseApproval: purchase };
      // The person approved paying at a site this run typed the approved card or pay token into: the
      // click still carries the approval to the page, with no card. Spent on the first purchase click there.
      if (approved || request.cardUse || !ctx.state.walletHosts.delete(purchase.site)) {
        request.purchase = purchase;
        request.fleetSummary = request.cardUse
          ? cardUseSummary(request.cardUse, purchase)
          : purchaseCardSummary(purchase);
      }
    }
    if (
      purchase ||
      request.cardUse ||
      request.loginUse ||
      given !== undefined ||
      givenCard !== undefined ||
      givenLogin !== undefined
    )
      request.effectRequest = args;
  }
  request.args = args;
  if (name === "respond_agent_connection" || name === "update_bot" || isFleetApprovalTool(name))
    request.effectRequest = args;
  return undefined;
}

/** Settings that change what this bot runs on or how it speaks; only the owner's chat sets them. */
const OWNER_SETTINGS = ["model", "thinkingLevel", "voice", "readAloud"];

/** Everything a bot may change on itself. Credentials, tools and access stay in Settings. */
const OWN_FIELDS = new Set([
  ...OWNER_SETTINGS,
  "name",
  "description",
  "instructions",
  "instructions_offset",
  "instructionsOffset",
  "color",
  "artifact_id",
  "use_attached_image",
  "notifyOnFinish",
  "dailyCheckIns",
  "notify_on_finish",
  "bot_id",
]);

/**
 * Every way an own update_bot call can name the model this bot runs on now: its id,
 * provider/id, and the label update_bot's read shows. A bot without its own model runs on the
 * space default, read fresh rather than from this run, which may record an earlier attempt.
 */
async function currentModelNames(
  ctx: RunContext,
  bot: { modelProvider: string | null; modelId: string | null },
): Promise<string[]> {
  const pinned = Boolean(bot.modelProvider && bot.modelId);
  const { provider, model } = pinned
    ? { provider: bot.modelProvider, model: bot.modelId }
    : await (await fleetPrepareDeps(ctx.deps, ctx.run)).modelChange.defaultModel();
  if (!provider || !model) return pinned ? [] : ["default"];
  const label = modelLabel(provider, model);
  return [
    model,
    `${provider}/${model}`,
    label,
    ...(pinned ? [] : ["default", `${label} (default)`]),
  ];
}

/**
 * `update_bot` on this bot itself. Under Never ask instructions are written at once; otherwise
 * they go through approval like any other action, and outside runs cannot change them.
 */
async function prepareOwnBotUpdate(
  ctx: RunContext,
  request: ToolRequest,
): Promise<PrepareRefusal | undefined> {
  const { run } = ctx;
  const { executionId, nextApprovedTool } = request;
  if (nextApprovedTool === "update_bot") {
    // The approved replay runs the stored request.
    request.heldForApproval = typeof request.args.previousInstructions === "string";
    return undefined;
  }
  const { previousInstructions: _previous, reason: _reason, ...given } = request.args;
  const current = await ctx.deps.prisma.bot.findUnique({
    where: { id: run.botId },
    select: {
      name: true,
      description: true,
      instructions: true,
      color: true,
      notifyOnFinish: true,
      dailyCheckIns: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
      autoSpeak: true,
      voiceId: true,
    },
  });
  const args = current
    ? dropUnchangedOwnBotArgs(
        given,
        current,
        argumentGiven(given.model) ? await currentModelNames(ctx, current) : [],
        current.thinkingLevel ? undefined : run.thinkingLevel,
      )
    : given;
  request.args = args;
  // A paged read never writes: the handler answers with the settings and names every other field
  // it left out, so the write checks below do not apply to those fields.
  if (argumentGiven(args.instructions_offset ?? args.instructionsOffset)) return undefined;
  const settingsOnly = Object.keys(args).filter(
    (key) => !OWN_FIELDS.has(key) && argumentGiven(args[key]),
  );
  if (settingsOnly.length)
    return refusal(
      "owner_only_settings",
      `Only the owner can change ${settingsOnly.join(", ")}, in Settings.`,
    );
  const unguarded = await neverAsks(ctx);
  if (OWNER_SETTINGS.some((key) => argumentGiven(args[key]))) {
    if (isSubagentToolExecution(executionId) || (!unguarded && !ctx.source.ownerStartedRun))
      return refusal(
        "owner_only_model_settings",
        "Only the owner can change your model, thinking, voice or read-aloud, from their own chat.",
      );
    if (!unguarded && (await isRunTainted(ctx)))
      return refuseOwnerSettingsChange(
        ctx,
        "Model, thinking, voice and read-aloud changes are blocked for the rest of this run because it read outside content.",
      );
  }
  if (!argumentGiven(args.instructions)) return undefined;
  if (isSubagentToolExecution(executionId))
    return refusal("helper_instructions", "Helpers cannot set instructions.");
  const instructions = String(args.instructions).trim();
  if (instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH)
    return refusal(
      "instructions_too_long",
      `instructions must be at most ${BOT_INSTRUCTIONS_MAX_LENGTH} characters.`,
    );
  if (redactSecrets(instructions, ctx.secrets) !== instructions)
    return refusal("instructions_contain_credentials", "Instructions cannot contain credentials.");
  request.args = { ...args, instructions };
  if (unguarded) return undefined;
  if (!["created", "routine"].includes(run.trigger) && !ctx.source.ownerStartedRun)
    return refusal(
      "instructions_run_not_owner_started",
      "Instruction changes are blocked for runs someone else started.",
    );
  if (Object.keys(args).some((key) => key !== "instructions"))
    return refusal(
      "instructions_need_own_call",
      "Change your instructions in their own update_bot call.",
    );
  // An older checkpoint predates the baseline; this attempt must not guess.
  if (ctx.state.ownInstructionsBaseline === undefined)
    return refusal("instructions_baseline_unknown", OWN_INSTRUCTIONS_BASELINE_UNKNOWN_ERROR);
  request.args = {
    instructions,
    reason: "Set in chat",
    // The text the model worked from, not a fresh read: a change that landed since the
    // attempt started conflicts at approval instead of being overwritten.
    previousInstructions: ctx.state.ownInstructionsBaseline,
    // Provenance the approved replay checks; requests stored before the baseline lack it.
    previousInstructionsFromBaseline: true,
  };
  request.heldForApproval = true;
  return undefined;
}
