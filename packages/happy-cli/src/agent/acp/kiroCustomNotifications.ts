import type { AgentGoalStatus } from '@/api/types';
import type { AgentMessage } from '@/agent/core';

type KiroCommand = {
  name?: unknown;
  description?: unknown;
};

type KiroGoalStatusParams = {
  state?: unknown;
  message?: unknown;
  iteration?: unknown;
  maxIterations?: unknown;
};

type KiroJsonRpcMessage = {
  method?: unknown;
  params?: unknown;
};

export type KiroGoalStatusSource = AgentGoalStatus['source'];

export type KiroCustomNotificationResult = {
  handled: boolean;
  messages: AgentMessage[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeKiroCommandName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

export function mapKiroAvailableCommands(params: unknown): { name: string; description?: string }[] | null {
  const payload = asRecord(params);
  const commands = payload?.commands;
  if (!Array.isArray(commands)) {
    return null;
  }

  return commands
    .map((item): { name: string; description?: string } | null => {
      const command = asRecord(item) as KiroCommand | null;
      if (!command || typeof command.name !== 'string' || command.name.trim().length === 0) {
        return null;
      }
      const normalized = normalizeKiroCommandName(command.name.trim());
      if (!normalized) {
        return null;
      }
      return {
        name: normalized,
        ...(typeof command.description === 'string' && command.description.trim().length > 0
          ? { description: command.description }
          : {}),
      };
    })
    .filter((item): item is { name: string; description?: string } => item !== null);
}

export function mapKiroGoalStatus(
  params: unknown,
  options: {
    source: KiroGoalStatusSource;
    sourceSessionId: string;
    observedAt?: number;
  },
): AgentGoalStatus | null {
  const status = asRecord(params) as KiroGoalStatusParams | null;
  if (!status || typeof status.state !== 'string') {
    return null;
  }

  const observedAt = options.observedAt ?? Date.now();
  const revisionParts = [
    status.state,
    typeof status.message === 'string' ? status.message : '',
    typeof status.iteration === 'number' ? status.iteration : '',
    typeof status.maxIterations === 'number' ? status.maxIterations : '',
  ];
  const sourceRevision = revisionParts.join(':');

  if (status.state === 'active') {
    const text = typeof status.message === 'string' && status.message.trim().length > 0
      ? status.message.trim()
      : 'Kiro goal';
    const currentStep = typeof status.iteration === 'number' ? status.iteration : undefined;
    const totalSteps = typeof status.maxIterations === 'number' ? status.maxIterations : undefined;

    return {
      source: options.source,
      status: 'active',
      observedAt,
      sourceSessionId: options.sourceSessionId,
      sourceRevision,
      text,
      capabilities: {
        clear: true,
        edit: true,
        // Kiro 的停止由现有 abort 按钮处理，目标栏 stop 目前在前端本来就不派发 RPC。
        stop: true,
      },
      progress: {
        ...(currentStep !== undefined ? { currentStep } : {}),
        ...(totalSteps !== undefined ? { totalSteps } : {}),
      },
    };
  }

  if (status.state === 'completed') {
    return {
      source: options.source,
      status: 'inactive',
      reason: 'completed',
      observedAt,
      sourceSessionId: options.sourceSessionId,
      sourceRevision,
    };
  }

  if (status.state === 'cleared' || status.state === 'cancelled' || status.state === 'canceled') {
    return {
      source: options.source,
      status: 'inactive',
      reason: 'cleared',
      observedAt,
      sourceSessionId: options.sourceSessionId,
      sourceRevision,
    };
  }

  return null;
}

export function handleKiroCustomNotificationLine(
  line: string,
  options: {
    goalStatusSource?: KiroGoalStatusSource;
    sourceSessionId?: string | null;
  },
): KiroCustomNotificationResult {
  let parsed: KiroJsonRpcMessage;
  try {
    parsed = JSON.parse(line) as KiroJsonRpcMessage;
  } catch {
    return { handled: false, messages: [] };
  }

  if (typeof parsed.method !== 'string') {
    return { handled: false, messages: [] };
  }

  if (parsed.method === '_kiro.dev/commands/available') {
    const commands = mapKiroAvailableCommands(parsed.params);
    return {
      handled: true,
      messages: commands
        ? [{ type: 'event', name: 'available_commands', payload: commands }]
        : [],
    };
  }

  if (parsed.method === '_kiro.dev/goal/status') {
    if (!options.goalStatusSource || !options.sourceSessionId) {
      return { handled: true, messages: [] };
    }
    const goalStatus = mapKiroGoalStatus(parsed.params, {
      source: options.goalStatusSource,
      sourceSessionId: options.sourceSessionId,
    });
    return {
      handled: true,
      messages: goalStatus
        ? [{ type: 'event', name: 'agent_goal_status', payload: goalStatus }]
        : [],
    };
  }

  // Kiro 的私有通知不是 ACP 标准 client method，必须先吃掉，避免 SDK 报 Method not found。
  if (parsed.method.startsWith('_kiro.dev/') || parsed.method.startsWith('_session/')) {
    return { handled: true, messages: [] };
  }

  return { handled: false, messages: [] };
}
