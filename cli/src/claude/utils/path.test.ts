import { describe, it, expect, vi } from 'vitest';
import { getProjectPath } from './path';
import * as os from 'node:os';
import { join } from 'node:path';

vi.mock('node:os');

describe('getProjectPath', () => {
  it('should return the default project path when CLAUDE_CONFIG_DIR is not set', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
    const workingDirectory = '/path/to/project';
    const expectedPath = join('/home/user', '.claude', 'projects', '-path-to-project');
    expect(getProjectPath(workingDirectory)).toBe(expectedPath);
  });

  it('should return the project path based on CLAUDE_CONFIG_DIR when it is set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config';
    const workingDirectory = '/path/to/project';
    const expectedPath = join('/custom/claude/config', 'projects', '-path-to-project');
    expect(getProjectPath(workingDirectory)).toBe(expectedPath);
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it.skipIf(process.platform !== 'win32')('should handle windows paths correctly', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\user');
    const workingDirectory = 'C:\\path\\to\\project';
    const expectedPath = 'C:\\Users\\user\\.claude\\projects\\C-path-to-project';
    expect(getProjectPath(workingDirectory)).toBe(expectedPath);
  });

  it('should handle relative paths', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
    const workingDirectory = 'relative/path';
    const resolvedWorkingDirectory = join(process.cwd(), workingDirectory);
    const projectId = resolvedWorkingDirectory.replace(/[\\\/.:]/g, '-');
    const expectedPath = join('/home/user', '.claude', 'projects', projectId);
    expect(getProjectPath(workingDirectory)).toBe(expectedPath);
  });
});
