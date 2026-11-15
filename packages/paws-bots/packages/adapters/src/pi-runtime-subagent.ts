import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isTerminatingReplyResult, terminatingReplyText } from "./approval-effect.js";
import { withAutomatedLabels } from "./automated-messages.js";
import { DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { withCloudflareAuth } from "./cloudflare-ai-gateway.js";
import { estimatePiImageTokens } from "./pi-image-context.js";
import { COMPUTER_MODE_TOOLS } from "./pi-runtime-computer-mode.js";
import {
  assistantText,
  providerFailureText,
  sanitizeError,
  sanitizeProviderError,
} from "./pi-runtime-errors.js";
import type { FallbackStreamState } from "./pi-runtime-fallback.js";
import { fallbackAwareModelStream } from "./pi-runtime-fallback.js";
import { clipToolResultText } from "./pi-runtime-limits.js";
import {
  cardOutputCeiling,
  modelForCompletion,
  resizeRuntimeTarget,
  resolveRuntimeModel,
  thinkingLevelFor,
} from "./pi-runtime-models.js";
import { conversationSessionId, reliableModelStream } from "./pi-runtime-stream.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import { toAgentTools, toolCallBudgetExceededMessage } from "./pi-runtime-tools.js";
import { observedPiStream } from "./pi-usage.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";
import { deliverFinishedShells } from "./shell-command-stream.js";
import { uniqueToolCallIdStream } from "./tool-call-ids.js";

export const MAX_PARALLEL_SUBAGENTS = 4;

/**
 * A helper's result within `limit` characters. A stop text (the spent-budget message or a
 * terminating reply) stays whole when it fits and only the narration before it is shortened;
 * clipped text ends with "…" and never goes past the limit.
 */
export function helperResultText(text: string, tail: string | undefined, limit: number): string {
  const clipTo = (value: string, max: number) =>
    value.length > max ? clipToolResultText(value, Math.max(0, max - 1)) : value;
  if (!tail) return clipTo(text, limit);
  if (tail.length > limit) return clipTo(tail, limit);
  const room = limit - tail.length - 2;
  return text && room > 1 ? `${clipTo(text, room)}\n\n${tail}` : tail;
}

export async function executeSubagent(
  host: ToolHost,
  executionId: string,
  args: Record<string, unknown>,
) {
  if (host.depth > 0) return "Subagents cannot nest further.";
  await host.subagentGate.acquire();
  const agentId = executionId;
  const name =
    String(args.name ?? "helper")
      .trim()
      .slice(0, 80) || "helper";
  const task = String(args.task ?? "").trim();
  const extra = args.instructions ? String(args.instructions).trim() : "";
  host.queue.push({
    type: "subagent",
    agentId,
    name,
    task,
    status: "running",
    progress: "starting…",
  });

  const requestedProvider = String(args.model_provider ?? "").trim();
  const requestedModelId = String(args.model_id ?? "").trim();
  const hasBackups = Boolean(host.request.fallbackModels?.length);
  let requestModel = hasBackups ? host.activeModel.config : host.request.model;
  try {
    if (Boolean(requestedProvider) !== Boolean(requestedModelId)) {
      throw new Error("model_provider and model_id must both be set");
    }
    if (requestedProvider && requestedModelId) {
      if (!host.request.resolveModel) {
        throw new Error("Per-call subagent model selection is unavailable");
      }
      requestModel = await host.request.resolveModel(requestedProvider, requestedModelId);
    }
  } catch (error) {
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "failed",
      result: message,
    });
    host.subagentGate.release();
    return `Subagent failed: ${message}`;
  }

  const selectedModel =
    hasBackups && requestModel === host.activeModel.config
      ? {
          ...host.activeModel,
          provider: host.activeModel.model.provider,
          modelId: host.activeModel.model.id,
        }
      : resolveRuntimeModel(requestModel);
  if (!selectedModel.model) {
    const message = `Unknown model ${selectedModel.provider}/${selectedModel.modelId}`;
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "failed",
      result: message,
    });
    host.subagentGate.release();
    return `Subagent failed: ${message}`;
  }
  const subagentModel = modelForCompletion(selectedModel.model, requestModel.maxTokens);

  // With a computer-use model, the screen belongs to top-level computer mode only.
  const childDefs = host.request.tools.filter(
    (tool) =>
      !DELEGATION_TOOL_NAMES.has(tool.name) &&
      !(host.computerModeAllowed && COMPUTER_MODE_TOOLS.has(tool.name)),
  );
  const nestedHost: ToolHost = {
    ...host,
    // The helper's transcript renames its own calls; they must not remap the main agent's ids.
    providerToolCallIds: new Map(),
    activeModel: {
      config: requestModel,
      models: selectedModel.models,
      model: subagentModel,
      cardMaxTokens: cardOutputCeiling(selectedModel.model),
      apiKey: selectedModel.apiKey,
      credentials: selectedModel.credentials,
    },
    models: selectedModel.models,
    model: subagentModel,
    apiKey: hasBackups
      ? (selectedModel.credentials?.accessToken ?? selectedModel.apiKey)
      : selectedModel.apiKey,
    depth: 1,
    agentNamespace: agentId,
    pendingShells: [],
    modelResponses: undefined,
    // A paused child or a spent shared budget stops the parent turn; a result that
    // ends only the child's turn stops the child, and the parent reads it as the
    // tool result, exactly as it reads a lone turn-ending result.
    abortTurn: () =>
      nestedHost.pausePending || host.toolCallBudget.exceeded ? host.abortTurn() : nested.abort(),
  };
  let contextPolicy = createRuntimeContextPolicy(
    {
      ...host.request,
      model: requestModel,
      history: [],
      prompt: task,
      sourceMessageId: undefined,
    },
    host.context,
    { credentialScope: selectedModel.apiKey, imageTokens: estimatePiImageTokens },
  );
  let nested!: Agent;
  const providerFailures = new WeakSet<AssistantMessage["content"]>();
  const retryState: FallbackStreamState = {
    request: { ...host.request, model: requestModel, fallbackModels: [] },
    getActive: () => nestedHost.activeModel,
    signal: host.signal,
    attempted: new Set(),
    nextIndex: 0,
    backupOutcomes: new Map(),
    selfRecoveries: 0,
    onSwitch: async () => undefined,
    onContextLimit: (contextWindow) => {
      const target = resizeRuntimeTarget(nestedHost.activeModel, contextWindow);
      nestedHost.activeModel = target;
      nestedHost.model = target.model;
      nested.state.model = target.model;
      contextPolicy = createRuntimeContextPolicy(
        {
          ...host.request,
          model: target.config,
          history: [],
          prompt: task,
          sourceMessageId: undefined,
        },
        host.context,
        { credentialScope: target.apiKey, imageTokens: estimatePiImageTokens },
      );
    },
    isProviderFailure: (message) => providerFailures.has(message.content),
    stream: (target, ctx, options) =>
      reliableModelStream(
        target.models,
        target.model,
        ctx,
        withCloudflareAuth(requestModel, options),
        target.config.maxTokens,
        () => selectedModel.credentials?.accessToken ?? selectedModel.apiKey,
        (preparedOptions) =>
          observedPiStream(
            target.models,
            target.model,
            ctx,
            preparedOptions,
            (event) => host.queue.push(event),
            target.config.callObserver ?? host.modelCallObserver,
            {
              operationKind: "subagent",
              agentId,
              userId: host.context?.userId,
              runId: host.request.runId,
            },
            {
              prepareContext: contextPolicy.prepareContext,
              imageTokens: estimatePiImageTokens,
              recordUsage: host.request.onUsage,
              onProviderError: (message) => providerFailures.add(message.content),
              onUsage: (usage) => {
                contextPolicy.onUsage(usage);
                const decision = contextPolicy.getDecision();
                if (decision)
                  host.onContextDecision?.({
                    ...decision,
                    runId: host.request.runId,
                    agentId,
                    usage,
                  });
              },
            },
          ),
        requestModel.cacheCapabilities?.retentionMode,
      ),
  };
  const toolCallIds = { used: new Set<string>(), provider: nestedHost.providerToolCallIds };
  nested = new Agent({
    finishTurn: async (turn, turnSignal) => {
      await deliverFinishedShells(
        (text) => {
          nested.steer({
            role: "user",
            content: text,
            timestamp: Date.now(),
          });
        },
        nestedHost.pendingShells,
        turn,
        turnSignal,
      );
    },
    sessionId: conversationSessionId(host.request.threadId, host.request.botId, agentId),
    streamFn: (_m, ctx, options) =>
      uniqueToolCallIdStream(
        fallbackAwareModelStream(
          retryState,
          ctx,
          withAutomatedLabels({ ...options, fetch: host.modelFetch ?? options?.fetch }),
        ),
        toolCallIds,
      ),
    getApiKey: async () =>
      hasBackups
        ? (selectedModel.credentials?.accessToken ?? selectedModel.apiKey)
        : selectedModel.apiKey,
    initialState: {
      systemPrompt: [
        `You are a Rakazo subagent named "${name}".`,
        "You run inside the parent bot's turn — you are not a separate bot chat.",
        "Complete the task and return a concise result. Do not spawn bots or further subagents.",
        "Your task comes from the parent bot, not from the human user, and you cannot talk to the user: report your result back to the parent bot.",
        "Messages marked as automated come from Rakazo, not from the user.",
        extra,
      ]
        .filter(Boolean)
        .join(" "),
      model: subagentModel,
      thinkingLevel: thinkingLevelFor(subagentModel, requestModel.thinkingLevel),
      tools: toAgentTools(childDefs, nestedHost),
      messages: [],
    },
  });
  host.nestedAgents.add(nested);

  let streamed = "";
  let lastPush = 0;
  // A tool result that ended the child's turn carries the reply the parent must read.
  let terminatedReply: string | undefined;
  nested.subscribe((event) => {
    if (event.type === "tool_execution_end" && isTerminatingReplyResult(event.result)) {
      terminatedReply = terminatingReplyText(event.result) ?? terminatedReply;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      // A later assistant turn supersedes the carried reply, except the empty aborted
      // message of a turn the terminating result itself ended.
      if (event.message.stopReason !== "aborted") terminatedReply = undefined;
    }
    if (event.type === "tool_execution_start") {
      if (host.toolCallBudget.exceeded) return;
      const toolName = "toolName" in event && event.toolName ? String(event.toolName) : "a tool";
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "running",
        progress: `using ${toolName}…`,
      });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (delta) {
        streamed += delta;
        const now = Date.now();
        if (now - lastPush >= 80) {
          lastPush = now;
          host.queue.push({
            type: "subagent",
            agentId,
            name,
            task,
            status: "running",
            progress: streamed.slice(-800),
          });
        }
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = assistantText(event.message);
      if (text && !streamed) streamed = text;
    }
  });

  try {
    if (host.signal.aborted) {
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "failed",
        result: "stopped",
      });
      return "stopped";
    }
    const onAbort = () => nested.abort();
    host.signal.addEventListener("abort", onAbort);
    try {
      await nested.prompt(
        `Task from the parent bot (not from the user):\n${task || "Complete the delegated task."}`,
      );
    } finally {
      try {
        await nested.waitForIdle();
      } finally {
        host.signal.removeEventListener("abort", onAbort);
        // nestedHost is a shallow copy; ask_user / request_takeover set pause
        // only on the child. Copy it up before the parent releases the budget.
        if (nestedHost.pausePending) host.pausePending = true;
      }
    }
    // Shared-budget abort leaves errorMessage on the nested agent; surface it as a
    // completed stop rather than a failed subagent chip.
    const budgetExceeded = host.toolCallBudget.exceeded;
    const error = nested.state.errorMessage || providerFailureText(nested.state.messages.at(-1));
    // The child's own terminating result aborted it mid-batch; the reply that result
    // carries is the helper's result, not a failure. A pause, a spent shared budget
    // and a stop of the whole run still report as before.
    const endedReply =
      terminatedReply && !nestedHost.pausePending && !host.signal.aborted && !budgetExceeded
        ? terminatedReply
        : undefined;
    if (error && !budgetExceeded && !endedReply) {
      const message = sanitizeProviderError(subagentModel.provider, error);
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "failed",
        result: message,
      });
      return `Subagent failed: ${message}`;
    }
    const budgetMessage = budgetExceeded
      ? toolCallBudgetExceededMessage(host.toolCallBudget.limit)
      : undefined;
    const label = `Result from your helper "${name}" (not a message from the user):\n`;
    // The parent clips label and result together, so the result gets what is left.
    const tail = budgetMessage ?? endedReply;
    const clipped = helperResultText(
      tail ? streamed.trim() : streamed || assistantText(nested.state.messages.at(-1)) || "done.",
      tail,
      12_000 - label.length,
    );
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "completed",
      result: clipped,
    });
    // The parent bot reads this as a tool result; say plainly that it is the helper talking.
    return `${label}${clipped}`;
  } catch (error) {
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "failed",
      result: message,
    });
    return `Subagent failed: ${message}`;
  } finally {
    host.nestedAgents.delete(nested);
    host.subagentGate.release();
  }
}
