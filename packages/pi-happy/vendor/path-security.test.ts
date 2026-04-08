import { describe, expect, it } from 'vitest';

import { validatePath } from './path-security';

describe('validatePath', () => {
  const workingDir = '/home/user/project';

  it('allows paths inside the working directory', () => {
    expect(validatePath('/home/user/project/file.txt', workingDir)).toEqual({
      valid: true,
      resolvedPath: '/home/user/project/file.txt',
    });
    expect(validatePath('file.txt', workingDir)).toEqual({
      valid: true,
      resolvedPath: '/home/user/project/file.txt',
    });
    expect(validatePath('./src/file.txt', workingDir)).toEqual({
      valid: true,
      resolvedPath: '/home/user/project/src/file.txt',
    });
  });

  it('rejects paths outside the working directory', () => {
    const result = validatePath('/etc/passwd', workingDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('outside the working directory');
  });

  it('prevents path traversal attacks', () => {
    const result = validatePath('../../.ssh/id_rsa', workingDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('outside the working directory');
  });

  it('allows the working directory itself', () => {
    expect(validatePath('.', workingDir)).toEqual({
      valid: true,
      resolvedPath: '/home/user/project',
    });
    expect(validatePath(workingDir, workingDir)).toEqual({
      valid: true,
      resolvedPath: '/home/user/project',
    });
  });

  it('rejects sibling paths that merely share a prefix', () => {
    const result = validatePath('/home/user/project-other/file.txt', workingDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('outside the working directory');
  });
});
