import { isAbsolute, relative, resolve } from 'node:path';

export interface PathValidationResult {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
}

export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
  const resolvedWorkingDir = resolve(workingDirectory);
  const resolvedTarget = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(resolvedWorkingDir, targetPath);

  const relativePath = relative(resolvedWorkingDir, resolvedTarget);
  const isWithinWorkingDirectory = relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath));

  if (!isWithinWorkingDirectory) {
    return {
      valid: false,
      resolvedPath: resolvedTarget,
      error: `Access denied: Path '${targetPath}' is outside the working directory`,
    };
  }

  return {
    valid: true,
    resolvedPath: resolvedTarget,
  };
}
