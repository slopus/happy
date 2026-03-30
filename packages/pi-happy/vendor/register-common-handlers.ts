import { createHash } from 'node:crypto';
import { exec, execFile, spawn, type ExecOptions } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { logger } from './logger';
import { validatePath } from './path-security';
import { RpcHandlerManager } from './rpc/handler-manager';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface BashRequest {
  command: string;
  cwd?: string;
  timeout?: number;
}

interface BashResponse {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}

interface ReadFileRequest {
  path: string;
}

interface ReadFileResponse {
  success: boolean;
  content?: string;
  error?: string;
}

interface WriteFileRequest {
  path: string;
  content: string;
  expectedHash?: string | null;
}

interface WriteFileResponse {
  success: boolean;
  hash?: string;
  error?: string;
}

interface ListDirectoryRequest {
  path: string;
}

interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
  size?: number;
  modified?: number;
}

interface ListDirectoryResponse {
  success: boolean;
  entries?: DirectoryEntry[];
  error?: string;
}

interface GetDirectoryTreeRequest {
  path: string;
  maxDepth: number;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: TreeNode[];
}

interface GetDirectoryTreeResponse {
  success: boolean;
  tree?: TreeNode;
  error?: string;
}

interface RipgrepRequest {
  args: string[];
  cwd?: string;
}

interface RipgrepResponse {
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

interface DifftasticRequest {
  args: string[];
  cwd?: string;
}

interface DifftasticResponse {
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface SpawnSessionOptions {
  machineId?: string;
  directory: string;
  sessionId?: string;
  approvedNewDirectoryCreation?: boolean;
  agent?: 'claude' | 'codex' | 'gemini' | 'openclaw';
  environmentVariables?: Record<string, string>;
  token?: string;
}

export type SpawnSessionResult =
  | { type: 'success'; sessionId: string }
  | { type: 'requestToApproveDirectoryCreation'; directory: string }
  | { type: 'error'; errorMessage: string };

async function which(binaryName: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, [binaryName]);
    const resolved = String(stdout)
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    return resolved ?? null;
  } catch {
    return null;
  }
}

async function runBinary(
  command: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts?.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', code => {
      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

async function runOptionalBinary(
  binaryName: string,
  args: string[],
  cwd?: string,
): Promise<{ success: true; exitCode: number; stdout: string; stderr: string } | { success: false; error: string }> {
  const binaryPath = await which(binaryName);
  if (!binaryPath) {
    return {
      success: false,
      error: `${binaryName} binary is not available on PATH`,
    };
  }

  try {
    const result = await runBinary(binaryPath, args, { cwd });
    return {
      success: true,
      ...result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : `Failed to run ${binaryName}`,
    };
  }
}

export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
  rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async data => {
    logger.debug('Shell command request:', data.command);

    if (data.cwd && data.cwd !== '/') {
      const validation = validatePath(data.cwd, workingDirectory);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      data.cwd = validation.resolvedPath;
    }

    try {
      const options: ExecOptions = {
        cwd: data.cwd === '/' ? undefined : data.cwd,
        timeout: data.timeout ?? 30_000,
      };

      logger.debug('Shell command executing...', { cwd: options.cwd, timeout: options.timeout });
      const { stdout, stderr } = await execAsync(data.command, options);
      const result = {
        success: true,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: 0,
      };
      logger.debug('Shell command result:', {
        success: result.success,
        exitCode: result.exitCode,
        stdoutLen: result.stdout.length,
        stderrLen: result.stderr.length,
      });
      return result;
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };

      if (execError.code === 'ETIMEDOUT' || execError.killed) {
        return {
          success: false,
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
          exitCode: typeof execError.code === 'number' ? execError.code : -1,
          error: 'Command timed out',
        };
      }

      return {
        success: false,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message ?? 'Command failed',
        exitCode: typeof execError.code === 'number' ? execError.code : 1,
        error: execError.message ?? 'Command failed',
      };
    }
  });

  rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async data => {
    logger.debug('Read file request:', data.path);
    const validation = validatePath(data.path, workingDirectory);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const buffer = await readFile(validation.resolvedPath!);
      return { success: true, content: buffer.toString('base64') };
    } catch (error) {
      logger.debug('Failed to read file:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
    }
  });

  rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async data => {
    logger.debug('Write file request:', data.path);
    const validation = validatePath(data.path, workingDirectory);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      if (data.expectedHash !== null && data.expectedHash !== undefined) {
        try {
          const existingBuffer = await readFile(validation.resolvedPath!);
          const existingHash = createHash('sha256').update(existingBuffer).digest('hex');
          if (existingHash !== data.expectedHash) {
            return {
              success: false,
              error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`,
            };
          }
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== 'ENOENT') {
            throw error;
          }
          return {
            success: false,
            error: 'File does not exist but hash was provided',
          };
        }
      } else {
        try {
          await stat(validation.resolvedPath!);
          return {
            success: false,
            error: 'File already exists but was expected to be new',
          };
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      const buffer = Buffer.from(data.content, 'base64');
      await writeFile(validation.resolvedPath!, buffer);
      const hash = createHash('sha256').update(buffer).digest('hex');
      return { success: true, hash };
    } catch (error) {
      logger.debug('Failed to write file:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
    }
  });

  rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>('listDirectory', async data => {
    logger.debug('List directory request:', data.path);
    const validation = validatePath(data.path, workingDirectory);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const directoryPath = validation.resolvedPath!;
      const entries = await readdir(directoryPath, { withFileTypes: true });
      const directoryEntries = await Promise.all(entries.map(async entry => {
        const fullPath = join(directoryPath, entry.name);
        let type: DirectoryEntry['type'] = 'other';
        if (entry.isDirectory()) {
          type = 'directory';
        } else if (entry.isFile()) {
          type = 'file';
        }

        try {
          const stats = await stat(fullPath);
          return {
            name: entry.name,
            type,
            size: stats.size,
            modified: stats.mtime.getTime(),
          } satisfies DirectoryEntry;
        } catch (error) {
          logger.debug(`Failed to stat ${fullPath}:`, error);
          return { name: entry.name, type } satisfies DirectoryEntry;
        }
      }));

      directoryEntries.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

      return { success: true, entries: directoryEntries };
    } catch (error) {
      logger.debug('Failed to list directory:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
    }
  });

  rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>('getDirectoryTree', async data => {
    logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth);
    const validation = validatePath(data.path, workingDirectory);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    if (data.maxDepth < 0) {
      return { success: false, error: 'maxDepth must be non-negative' };
    }

    async function buildTree(path: string, name: string, currentDepth: number): Promise<TreeNode | null> {
      try {
        const stats = await stat(path);
        const node: TreeNode = {
          name,
          path,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: stats.mtime.getTime(),
        };

        if (stats.isDirectory() && currentDepth < data.maxDepth) {
          const entries = await readdir(path, { withFileTypes: true });
          const children: TreeNode[] = [];

          await Promise.all(entries.map(async entry => {
            if (entry.isSymbolicLink()) {
              logger.debug(`Skipping symlink: ${join(path, entry.name)}`);
              return;
            }
            const childPath = join(path, entry.name);
            const childNode = await buildTree(childPath, entry.name, currentDepth + 1);
            if (childNode) {
              children.push(childNode);
            }
          }));

          children.sort((a, b) => {
            if (a.type === 'directory' && b.type !== 'directory') return -1;
            if (a.type !== 'directory' && b.type === 'directory') return 1;
            return a.name.localeCompare(b.name);
          });

          node.children = children;
        }

        return node;
      } catch (error) {
        logger.debug(`Failed to process ${path}:`, error instanceof Error ? error.message : String(error));
        return null;
      }
    }

    try {
      const rootPath = validation.resolvedPath!;
      const baseName = rootPath === '/' ? '/' : rootPath.split('/').pop() || rootPath;
      const tree = await buildTree(rootPath, baseName, 0);
      if (!tree) {
        return { success: false, error: 'Failed to access the specified path' };
      }
      return { success: true, tree };
    } catch (error) {
      logger.debug('Failed to get directory tree:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
    }
  });

  rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async data => {
    logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);
    if (data.cwd) {
      const validation = validatePath(data.cwd, workingDirectory);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      data.cwd = validation.resolvedPath;
    }

    const result = await runOptionalBinary('rg', data.args, data.cwd);
    if (!result.success) {
      logger.debug('Failed to run ripgrep:', result.error);
      return { success: false, error: result.error };
    }

    return {
      success: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });

  rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>('difftastic', async data => {
    logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);
    if (data.cwd) {
      const validation = validatePath(data.cwd, workingDirectory);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      data.cwd = validation.resolvedPath;
    }

    const result = await runOptionalBinary('difft', data.args, data.cwd);
    if (!result.success) {
      logger.debug('Failed to run difftastic:', result.error);
      return { success: false, error: result.error };
    }

    return {
      success: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}
