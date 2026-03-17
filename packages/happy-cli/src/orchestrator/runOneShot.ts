import { spawn } from 'node:child_process';
import { claudeCliPath } from '@/claude/claudeLocal';
import { logger } from '@/ui/logger';
import { MODEL_MODE_DEFAULT, isModelModeForAgent, parseCodexModelMode } from 'happy-wire';
import {
  ORCHESTRATOR_ENV_KEYS,
  type OrchestratorProvider,
  decodePromptFromBase64,
  isOrchestratorProvider,
} from './common';

type SpawnPlan = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

function parseProvider(providerArg: string | undefined): OrchestratorProvider {
  if (!providerArg || !isOrchestratorProvider(providerArg)) {
    throw new Error(`Invalid --provider value: ${providerArg ?? '(missing)'}`);
  }
  return providerArg;
}

function readPromptFromEnv(): string {
  const promptB64 = process.env[ORCHESTRATOR_ENV_KEYS.promptB64];
  if (!promptB64) {
    throw new Error(`${ORCHESTRATOR_ENV_KEYS.promptB64} is required`);
  }
  return decodePromptFromBase64(promptB64);
}

function readWorkingDirectoryFromEnv(): string | undefined {
  const value = process.env[ORCHESTRATOR_ENV_KEYS.workingDirectory];
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value;
}

function readModelModeFromEnv(): string | undefined {
  const value = process.env[ORCHESTRATOR_ENV_KEYS.modelMode];
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value;
}

function readExecutionTypeFromEnv(): 'initial' | 'resume' {
  const value = process.env[ORCHESTRATOR_ENV_KEYS.executionType];
  if (value === 'resume') {
    return 'resume';
  }
  return 'initial';
}

function readChildSessionIdFromEnv(): string | undefined {
  const value = process.env[ORCHESTRATOR_ENV_KEYS.childSessionId];
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value;
}

export function buildSpawnPlan(
  provider: OrchestratorProvider,
  prompt: string,
  workingDirectory?: string,
  modelMode?: string,
  executionType: 'initial' | 'resume' = 'initial',
  childSessionId?: string,
): SpawnPlan {
  if (executionType === 'resume' && !childSessionId) {
    throw new Error('childSessionId is required for resume execution');
  }
  const normalizedModelMode = modelMode === MODEL_MODE_DEFAULT ? undefined : modelMode;
  switch (provider) {
    case 'claude':
      return {
        command: 'node',
        args: executionType === 'resume'
          ? [claudeCliPath, '--resume', childSessionId!, '-p', prompt]
          : [claudeCliPath, ...(normalizedModelMode ? ['--model', normalizedModelMode] : []), ...(childSessionId ? ['--session-id', childSessionId] : []), '-p', prompt],
        cwd: workingDirectory,
        env: {
          ...process.env,
          DISABLE_AUTOUPDATER: '1',
        },
      };
    case 'codex': {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ORCH_PROMPT: prompt,
        ...(childSessionId ? { ORCH_CHILD_SESSION_ID: childSessionId } : {}),
      };
      if (executionType === 'resume') {
        return {
          command: 'bash',
          args: ['-lc', 'npx -y @openai/codex@0.114.0 exec resume "$ORCH_CHILD_SESSION_ID" "$ORCH_PROMPT"'],
          cwd: workingDirectory,
          env,
        };
      }
      if (normalizedModelMode) {
        if (isModelModeForAgent('codex', normalizedModelMode)) {
          const parsed = parseCodexModelMode(normalizedModelMode);
          if (parsed.family !== MODEL_MODE_DEFAULT) {
            env.ORCH_MODEL = parsed.family;
            env.ORCH_REASONING_EFFORT = parsed.effort;
          }
        } else {
          env.ORCH_MODEL = normalizedModelMode;
        }
      }
      return {
        command: 'bash',
        args: ['-lc', 'cmd=(npx -y @openai/codex@0.114.0 exec "$ORCH_PROMPT"); if [ -n "$ORCH_MODEL" ]; then cmd+=(--model "$ORCH_MODEL"); fi; if [ -n "$ORCH_REASONING_EFFORT" ]; then cmd+=(--reasoning-effort "$ORCH_REASONING_EFFORT"); fi; "${cmd[@]}"'],
        cwd: workingDirectory,
        env,
      };
    }
    case 'gemini':
      return {
        command: 'bash',
        args: executionType === 'resume'
          ? ['-lc', 'gemini --resume "$ORCH_CHILD_SESSION_ID" -p "$ORCH_PROMPT"']
          : ['-lc', 'cmd=(gemini -p "$ORCH_PROMPT" --output-format json); if [ -n "$ORCH_MODEL" ]; then cmd+=(--model "$ORCH_MODEL"); fi; "${cmd[@]}"'],
        cwd: workingDirectory,
        env: {
          ...process.env,
          ORCH_PROMPT: prompt,
          ...(childSessionId ? { ORCH_CHILD_SESSION_ID: childSessionId } : {}),
          ...(normalizedModelMode ? { ORCH_MODEL: normalizedModelMode } : {}),
        },
      };
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function spawnAndWait(plan: SpawnPlan): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('exit', (code) => {
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

function readProviderFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider') {
      return args[i + 1];
    }
  }
  return undefined;
}

export async function runOrchestratorOneShot(args: string[]): Promise<number> {
  const provider = parseProvider(readProviderFromArgs(args));
  const prompt = readPromptFromEnv();
  const workingDirectory = readWorkingDirectoryFromEnv();
  const modelMode = readModelModeFromEnv();
  const executionType = readExecutionTypeFromEnv();
  const childSessionId = readChildSessionIdFromEnv();
  logger.debug(`[ORCHESTRATOR ONESHOT] Starting ${provider} one-shot`);

  const plan = buildSpawnPlan(provider, prompt, workingDirectory, modelMode, executionType, childSessionId);
  return spawnAndWait(plan);
}
