import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { claudeFindLastSession } from '@/claude/utils/claudeFindLastSession';
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning';
import { spawnDaemonSession } from '@/daemon/controlClient';

type AttachAgent = 'claude' | 'codex';

export type AttachTarget =
  | {
    agent: 'claude';
    directory: string;
    resumeClaudeSessionId: string;
    json: boolean;
  }
  | {
    agent: 'codex';
    directory: string;
    resumeCodexThreadId: string;
    json: boolean;
  };

type AttachRuntime = {
  cwd: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

const PAWS_SKILL = `---
name: paws
description: Attach the current Claude Code or Codex session to Paws mobile. Use when the user asks to continue this current session on Paws or types /paws.
---

Run this command from the current working directory:

\`\`\`bash
happy attach --json
\`\`\`

Report the returned session id briefly. Do not run a foreground long-lived Happy session such as \`happy codex --resume ...\` or \`happy claude --resume ...\`; \`happy attach\` uses the daemon to start the mobile-controlled session in the background.
`;

function formatAttachHelp(): string {
  return [
    'happy attach - Attach the current Claude Code or Codex session to Paws',
    '',
    'Usage:',
    '  happy attach [--agent claude|codex] [--json]',
    '  happy attach --codex-thread-id <id>',
    '  happy attach --claude-session-id <uuid>',
    '',
    'Examples:',
    '  happy attach',
    '  happy attach --agent codex --json',
  ].join('\n');
}

export function getSlashCommandInstallPaths(options: { homeDir?: string } = {}): string[] {
  const homeDir = options.homeDir ?? homedir();
  return [
    resolve(homeDir, '.claude', 'skills', 'paws', 'SKILL.md'),
    resolve(homeDir, '.codex', 'skills', 'paws', 'SKILL.md'),
    resolve(homeDir, '.agents', 'skills', 'paws', 'SKILL.md'),
  ];
}

export async function isSlashCommandInstalled(options: { homeDir?: string } = {}): Promise<boolean> {
  const paths = getSlashCommandInstallPaths(options);
  const contents = await Promise.all(paths.map(async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }));

  return contents.every((content) => content?.includes('happy attach --json'));
}

function readOption(args: string[], name: string): string | undefined {
  const eqPrefix = `${name}=`;
  const eq = args.find((arg) => arg.startsWith(eqPrefix));
  if (eq) {
    return eq.slice(eqPrefix.length);
  }

  const index = args.indexOf(name);
  if (index !== -1 && index + 1 < args.length) {
    const value = args[index + 1];
    if (!value.startsWith('-')) {
      return value;
    }
  }

  return undefined;
}

function resolvePath(pathValue: string, cwd: string): string {
  const expanded = pathValue.replace(/^~(?=\/|$)/, homedir());
  return resolve(cwd, expanded);
}

export async function installSlashCommand(options: { homeDir?: string } = {}): Promise<string[]> {
  const paths = getSlashCommandInstallPaths(options);

  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, PAWS_SKILL, 'utf8');
  }

  return paths;
}

export function resolveAttachTarget(args: string[], runtime: AttachRuntime = {
  cwd: process.cwd(),
  env: process.env,
}): AttachTarget {
  if (args.includes('--help') || args.includes('-h')) {
    throw new Error(formatAttachHelp());
  }

  const json = args.includes('--json');
  const directory = resolvePath(readOption(args, '--path') ?? runtime.cwd, runtime.cwd);
  const explicitAgent = readOption(args, '--agent') as AttachAgent | undefined;
  const explicitCodexThreadId = readOption(args, '--codex-thread-id');
  const explicitClaudeSessionId = readOption(args, '--claude-session-id');

  if (explicitAgent && explicitAgent !== 'claude' && explicitAgent !== 'codex') {
    throw new Error(`Unsupported attach agent "${explicitAgent}". Expected "claude" or "codex".`);
  }

  const inferredAgent: AttachAgent | undefined = explicitAgent
    ?? (explicitCodexThreadId ? 'codex' : undefined)
    ?? (explicitClaudeSessionId ? 'claude' : undefined)
    ?? (runtime.env.CODEX_THREAD_ID ? 'codex' : undefined)
    ?? (runtime.env.CLAUDE_SESSION_ID ? 'claude' : undefined);

  if (inferredAgent === 'codex') {
    const resumeCodexThreadId = explicitCodexThreadId ?? runtime.env.CODEX_THREAD_ID;
    if (!resumeCodexThreadId) {
      throw new Error('Could not find a Codex thread to attach. Pass --codex-thread-id <id> or run from inside Codex.');
    }
    return {
      agent: 'codex',
      directory,
      resumeCodexThreadId,
      json,
    };
  }

  const resumeClaudeSessionId = explicitClaudeSessionId
    ?? runtime.env.CLAUDE_SESSION_ID
    ?? claudeFindLastSession(directory)
    ?? undefined;

  if (!resumeClaudeSessionId) {
    throw new Error('Could not find a Claude session to attach. Pass --claude-session-id <uuid> or run from a Claude project with saved history.');
  }

  return {
    agent: 'claude',
    directory,
    resumeClaudeSessionId,
    json,
  };
}

export async function handleAttachCommand(args: string[], runtime?: AttachRuntime): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(formatAttachHelp());
    return;
  }
  if (args.includes('--install-slash-command')) {
    const installed = await installSlashCommand();
    console.log(`Installed /paws skill:\n${installed.map((path) => `- ${path}`).join('\n')}`);
    return;
  }

  const target = resolveAttachTarget(args, runtime);
  const attachEnv = runtime?.env ?? process.env;
  await ensureDaemonRunning();

  const result = await spawnDaemonSession(
    target.agent === 'codex'
      ? {
        directory: target.directory,
        agent: 'codex',
        resumeCodexThreadId: target.resumeCodexThreadId,
        environmentVariables: {
          // `attach` means joining the current live Codex Thread. Spawning a
          // second app-server would create competing writers for that Thread.
          HAPPY_CODEX_APP_SERVER_MODE: 'shared',
          HAPPY_CODEX_APPROVAL_AUTHORITY: attachEnv.HAPPY_CODEX_APPROVAL_AUTHORITY ?? 'desktop',
          ...(attachEnv.HAPPY_CODEX_APP_SERVER_SOCKET
            ? { HAPPY_CODEX_APP_SERVER_SOCKET: attachEnv.HAPPY_CODEX_APP_SERVER_SOCKET }
            : {}),
        },
      }
      : {
        directory: target.directory,
        agent: 'claude',
        resumeClaudeSessionId: target.resumeClaudeSessionId,
      },
  );

  if (result?.error) {
    throw new Error(result.error);
  }
  if (result?.success === false) {
    throw new Error(result.error ?? 'Failed to attach session to Paws.');
  }
  if (!result?.sessionId) {
    throw new Error('Failed to attach session to Paws: daemon did not return a session id.');
  }

  const payload = {
    type: 'success',
    sessionId: result.sessionId,
    agent: target.agent,
    directory: target.directory,
  };

  if (target.json) {
    console.log(JSON.stringify(payload));
    return;
  }

  console.log(`Attached ${target.agent} session to Paws: ${result.sessionId}`);
}
