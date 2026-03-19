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
        command: process.execPath,
        args: executionType === 'resume'
          ? [claudeCliPath, '--dangerously-skip-permissions', '--resume', childSessionId!, '-p', prompt]
          : [claudeCliPath, '--dangerously-skip-permissions', ...(normalizedModelMode ? ['--model', normalizedModelMode] : []), ...(childSessionId ? ['--session-id', childSessionId] : []), '-p', prompt],
        cwd: workingDirectory,
        env: {
          ...process.env,
          DISABLE_AUTOUPDATER: '1',
        },
      };
    case 'codex': {
      const codexArgs = ['-y', '@openai/codex@0.115.0', 'exec', '--dangerously-bypass-approvals-and-sandbox'];
      if (executionType === 'resume') {
        codexArgs.push('resume', childSessionId!, prompt);
      } else {
        codexArgs.push(prompt);
        if (normalizedModelMode) {
          if (isModelModeForAgent('codex', normalizedModelMode)) {
            const parsed = parseCodexModelMode(normalizedModelMode);
            if (parsed.family !== MODEL_MODE_DEFAULT) {
              codexArgs.push('--model', parsed.family);
              if (parsed.effort) {
                codexArgs.push('-c', `model_reasoning_effort=${parsed.effort}`);
              }
            }
          } else {
            codexArgs.push('--model', normalizedModelMode);
          }
        }
      }
      return {
        command: 'npx',
        args: codexArgs,
        cwd: workingDirectory,
        env: { ...process.env },
      };
    }
    case 'gemini': {
      const geminiArgs = ['--yolo'];
      if (executionType === 'resume') {
        geminiArgs.push('--resume', childSessionId!, '-p', prompt);
      } else {
        geminiArgs.push('-p', prompt, '--output-format', 'json');
        if (normalizedModelMode) {
          geminiArgs.push('--model', normalizedModelMode);
        }
      }
      return {
        command: 'gemini',
        args: geminiArgs,
        cwd: workingDirectory,
        env: { ...process.env },
      };
    }
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
