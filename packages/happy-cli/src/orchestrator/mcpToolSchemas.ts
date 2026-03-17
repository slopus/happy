import { z } from 'zod';

const orchestratorTaskSchema = z.object({
  taskKey: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(256).optional(),
  provider: z.enum(['claude', 'codex', 'gemini']),
  model: z.string().min(1).max(128).optional()
    .describe('Optional. Call orchestrator_get_context first and choose from data.modelModes[provider]. Use "default" to follow CLI defaults.'),
  prompt: z.string().min(1).max(65536),
  workingDirectory: z.string().max(512).optional(),
  timeoutMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
  dependsOn: z.array(z.string().min(1).max(128)).max(31).optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(10).optional(),
    backoffMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  }).optional(),
  target: z.object({
    type: z.enum(['current_machine', 'machine_id']),
    machineId: z.string().optional(),
  }).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const ORCHESTRATOR_GET_CONTEXT_TOOL_SCHEMA = {
  description: 'Get orchestrator defaults and controller session context for this current MCP session.',
  title: 'Orchestrator Get Context',
  inputSchema: {},
} as const;

export const ORCHESTRATOR_SUBMIT_TOOL_SCHEMA = {
  description: 'Submit an orchestrator run. In blocking mode this tool loops orchestrator_pend until terminal or timeout.',
  title: 'Orchestrator Submit',
  inputSchema: {
    title: z.string().min(1).max(256).describe('Run title'),
    tasks: z.array(orchestratorTaskSchema).min(1).max(32),
    mode: z.enum(['async', 'blocking']).optional().describe('Blocking mode waits until run terminal in MCP layer'),
    maxConcurrency: z.number().int().min(1).max(8).optional(),
    waitTimeoutMs: z.number().int().min(1000).max(60 * 60 * 1000).optional().describe('Blocking mode total timeout'),
    pollIntervalMs: z.number().int().min(200).max(60_000).optional().describe('Blocking mode per-pend wait timeout'),
    idempotencyKey: z.string().min(1).max(128).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    controllerSessionId: z.string().optional(),
  },
} as const;

export const ORCHESTRATOR_PEND_TOOL_SCHEMA = {
  description: 'Wait for orchestrator run changes or terminal status.',
  title: 'Orchestrator Pend',
  inputSchema: {
    runId: z.string().describe('Run ID'),
    cursor: z.string().optional(),
    waitFor: z.enum(['change', 'terminal']).optional(),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
    include: z.enum(['summary', 'all_tasks']).optional(),
  },
} as const;

export const ORCHESTRATOR_LIST_TOOL_SCHEMA = {
  description: 'List orchestrator runs for current account.',
  title: 'Orchestrator List',
  inputSchema: {
    status: z.enum(['active', 'terminal', 'queued', 'running', 'canceling', 'completed', 'failed', 'cancelled']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional(),
  },
} as const;

export const ORCHESTRATOR_CANCEL_TOOL_SCHEMA = {
  description: 'Request cancellation for an orchestrator run.',
  title: 'Orchestrator Cancel',
  inputSchema: {
    runId: z.string().describe('Run ID'),
    reason: z.string().max(512).optional(),
  },
} as const;

export const ORCHESTRATOR_SEND_MESSAGE_TOOL_SCHEMA = {
  description: 'Send an additional message to a completed/failed orchestrator task and resume its child session.',
  title: 'Orchestrator Send Message',
  inputSchema: {
    taskId: z.string().describe('Task ID to resume'),
    message: z.string().min(1).max(65_536).describe('Message to send to the existing child session'),
  },
} as const;
