import { spawn } from 'node:child_process';
import { claudeCliPath } from '@/claude/claudeLocal';
import { logger } from '@/ui/logger';
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

function buildSpawnPlan(provider: OrchestratorProvider, prompt: string): SpawnPlan {
  switch (provider) {
    case 'claude':
      return {
        command: 'node',
        args: [claudeCliPath, '-p', prompt],
        env: {
          ...process.env,
          DISABLE_AUTOUPDATER: '1',
        },
      };
    case 'codex':
      return {
        command: 'bash',
        args: ['-lc', 'npx -y @openai/codex@0.114.0 exec "$ORCH_PROMPT"'],
        env: {
          ...process.env,
          ORCH_PROMPT: prompt,
        },
      };
    case 'gemini':
      return {
        command: 'bash',
        args: ['-lc', 'gemini -p "$ORCH_PROMPT"'],
        env: {
          ...process.env,
          ORCH_PROMPT: prompt,
        },
      };
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function spawnAndWait(plan: SpawnPlan): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: process.cwd(),
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
  logger.debug(`[ORCHESTRATOR ONESHOT] Starting ${provider} one-shot`);

  const plan = buildSpawnPlan(provider, prompt);
  return spawnAndWait(plan);
}
