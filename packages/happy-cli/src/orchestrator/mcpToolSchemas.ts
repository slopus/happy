import { z } from 'zod';

const orchestratorTargetTypeSchema = z.preprocess(
  (value) => value === 'machine' ? 'machine_id' : value,
  z.enum(['current_machine', 'machine_id']),
).describe('Dispatch target type. Use "current_machine" for this machine, or "machine_id" for explicit machine routing. Alias "machine" is accepted and normalized to "machine_id".');

const orchestratorTaskSchema = z.object({
  taskKey: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(256).optional(),
  provider: z.enum(['claude', 'codex', 'gemini'])
    .describe('AI agent provider to execute the task.'),
  model: z.string().min(1).max(128).optional()
    .describe('Optional model mode for the selected provider. Prefer values from orchestrator_get_context.data.modelModes[provider]. Use "default" to follow CLI defaults.'),
  prompt: z.string().min(1).max(65536),
  workingDirectory: z.string().max(512).optional()
    .describe('Absolute path for task execution. Defaults to the controller session working directory from get_context.'),
  timeoutMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional()
    .describe('Task timeout in milliseconds (1000..86400000).'),
  dependsOn: z.array(z.string().min(1).max(128)).max(31).optional()
    .describe('Optional list of dependency taskKey values. Use taskKey names, not taskId.'),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(10).optional()
      .describe('Maximum attempts for this task (including first run).'),
    backoffMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional()
      .describe('Retry backoff delay in milliseconds before the next attempt.'),
  }).optional(),
  target: z.object({
    type: orchestratorTargetTypeSchema,
    machineId: z.string().optional()
      .describe('Required when target.type is "machine_id" (or alias "machine").'),
  }).optional().describe('Optional dispatch routing target.'),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const ORCHESTRATOR_GET_CONTEXT_TOOL_SCHEMA = {
  description: 'Get available AI providers, models, and session context before creating a dispatch.',
  title: 'Orchestrator Get Context',
  inputSchema: {},
} as const;

export const ORCHESTRATOR_SUBMIT_TOOL_SCHEMA = {
  description: 'Delegate to AI agents — dispatch one or more prompts across providers (claude/codex/gemini) to run in parallel or with dependency chains. Use this to assign, hand off, distribute, or orchestrate work across AI providers. Each submission creates a "dispatch" that can be tracked, cancelled, or resumed. Supports blocking (wait for completion) and async modes.',
  title: 'Orchestrator Submit',
  inputSchema: {
    title: z.string().min(1).max(256).describe('Run title'),
    tasks: z.array(orchestratorTaskSchema).min(1).max(32),
    mode: z.enum(['async', 'blocking']).optional().describe('Run mode. "blocking" waits for terminal state; "async" returns immediately.'),
    maxConcurrency: z.number().int().min(1).max(8).optional(),
    waitTimeoutMs: z.number().int().min(1000).max(60 * 60 * 1000).optional().describe('Blocking-mode total wait timeout in ms (max 3600000). Only applies when mode="blocking".'),
    pollIntervalMs: z.number().int().min(200).max(60_000).optional().describe('Blocking-mode pend poll interval in milliseconds.'),
    idempotencyKey: z.string().min(1).max(128).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    controllerSessionId: z.string().optional().describe('Optional controller session ID. Defaults to current MCP session when omitted.'),
  },
} as const;

export const ORCHESTRATOR_PEND_TOOL_SCHEMA = {
  description: 'Wait for a dispatch to finish — poll for progress or block until completion.',
  title: 'Orchestrator Pend',
  inputSchema: {
    runId: z.string().describe('Run ID'),
    cursor: z.string().optional(),
    waitFor: z.enum(['change', 'terminal']).optional(),
    timeoutMs: z.number().int().min(0).max(120_000).optional()
      .describe('Server-side long-poll timeout in ms (max 120000). For longer waits, call pend repeatedly.'),
    include: z.enum(['summary', 'all_tasks']).optional()
      .describe('"summary" returns run-level status only; "all_tasks" includes per-task details.'),
  },
} as const;

export const ORCHESTRATOR_LIST_TOOL_SCHEMA = {
  description: 'List all dispatches and their current status (active, completed, failed).',
  title: 'Orchestrator List',
  inputSchema: {
    status: z.enum(['active', 'terminal', 'queued', 'running', 'canceling', 'completed', 'failed', 'cancelled']).optional()
      .describe('Filter by status. "active" = queued|running|canceling; "terminal" = completed|failed|cancelled.'),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional(),
  },
} as const;

export const ORCHESTRATOR_CANCEL_TOOL_SCHEMA = {
  description: 'Cancel a dispatch that is queued or in progress.',
  title: 'Orchestrator Cancel',
  inputSchema: {
    runId: z.string().describe('Run ID'),
    reason: z.string().max(512).optional(),
  },
} as const;

export const ORCHESTRATOR_SEND_MESSAGE_TOOL_SCHEMA = {
  description: 'Resume a completed or failed dispatch by sending a follow-up message to its session.',
  title: 'Orchestrator Send Message',
  inputSchema: {
    taskId: z.string().describe('Task ID to resume'),
    message: z.string().min(1).max(65_536).describe('Message to send to the existing child session'),
  },
} as const;
