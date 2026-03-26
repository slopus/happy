import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from 'happy-agent/encryption';

import { registerCommonHandlers } from './register-common-handlers';
import { RpcHandlerManager } from './rpc/handler-manager';

type RpcResult = Record<string, unknown>;

describe('registerCommonHandlers', () => {
  let workingDirectory: string;
  let manager: RpcHandlerManager;
  let encryptionKey: Uint8Array;

  beforeEach(() => {
    workingDirectory = mkdtempSync(join(tmpdir(), 'pi-happy-rpc-'));
    mkdirSync(join(workingDirectory, 'dir'));
    mkdirSync(join(workingDirectory, 'nested', 'child'), { recursive: true });
    writeFileSync(join(workingDirectory, 'hello.txt'), 'hello world');
    writeFileSync(join(workingDirectory, 'nested', 'child', 'deep.txt'), 'deep file');
    try {
      symlinkSync(join(workingDirectory, 'hello.txt'), join(workingDirectory, 'nested', 'hello-link.txt'));
    } catch {
      // Symlink creation is best-effort in CI environments.
    }

    encryptionKey = getRandomBytes(32);
    manager = new RpcHandlerManager({
      scopePrefix: 'session-abc',
      encryptionKey,
      encryptionVariant: 'legacy',
    });

    registerCommonHandlers(manager, workingDirectory);
  });

  afterEach(() => {
    rmSync(workingDirectory, { recursive: true, force: true });
  });

  async function invoke(method: string, params: unknown): Promise<RpcResult> {
    const response = await manager.handleRequest({
      method: `session-abc:${method}`,
      params: encodeBase64(encrypt(encryptionKey, 'legacy', params)),
    });

    return decrypt(encryptionKey, 'legacy', decodeBase64(response)) as RpcResult;
  }

  it('executes bash commands inside the working directory', async () => {
    const result = await invoke('bash', {
      command: `${process.execPath} -e "process.stdout.write(process.cwd())"`,
      cwd: '.',
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain(workingDirectory);
  });

  it('rejects bash requests outside the working directory', async () => {
    const result = await invoke('bash', {
      command: 'echo should-not-run',
      cwd: '../',
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('outside the working directory');
  });

  it('reads files as base64', async () => {
    const result = await invoke('readFile', { path: 'hello.txt' });

    expect(result.success).toBe(true);
    expect(Buffer.from(String(result.content), 'base64').toString('utf8')).toBe('hello world');
  });

  it('writes a new file and returns its hash', async () => {
    const content = Buffer.from('new content').toString('base64');

    const result = await invoke('writeFile', {
      path: 'dir/new.txt',
      content,
      expectedHash: null,
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(workingDirectory, 'dir', 'new.txt'), 'utf8')).toBe('new content');
    expect(result.hash).toBe(createHash('sha256').update('new content').digest('hex'));
  });

  it('rejects writes when the expected hash mismatches', async () => {
    const result = await invoke('writeFile', {
      path: 'hello.txt',
      content: Buffer.from('updated').toString('base64'),
      expectedHash: 'not-the-real-hash',
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('File hash mismatch');
  });

  it('lists directories with folders first', async () => {
    writeFileSync(join(workingDirectory, 'a-file.txt'), 'a');
    mkdirSync(join(workingDirectory, 'z-dir'));

    const result = await invoke('listDirectory', { path: '.' });

    expect(result.success).toBe(true);
    expect(result.entries).toMatchObject([
      { name: 'dir', type: 'directory' },
      { name: 'nested', type: 'directory' },
      { name: 'z-dir', type: 'directory' },
      { name: 'a-file.txt', type: 'file' },
      { name: 'hello.txt', type: 'file' },
    ]);
  });

  it('builds a directory tree and skips symlink traversal', async () => {
    const result = await invoke('getDirectoryTree', { path: '.', maxDepth: 3 });

    expect(result.success).toBe(true);
    const tree = result.tree as { children?: Array<{ name: string; children?: unknown[] }> };
    expect(tree.children?.find(child => child.name === 'nested')).toBeTruthy();

    const nested = tree.children?.find(child => child.name === 'nested');
    const nestedChildren = nested?.children as Array<{ name: string }> | undefined;
    expect(nestedChildren?.find(child => child.name === 'hello-link.txt')).toBeUndefined();
  });

  it('returns a clear error when ripgrep is unavailable', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';

    try {
      const result = await invoke('ripgrep', { args: ['hello'], cwd: '.' });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('rg binary is not available on PATH');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('returns a clear error when difftastic is unavailable', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';

    try {
      const result = await invoke('difftastic', { args: ['--version'], cwd: '.' });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('difft binary is not available on PATH');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
