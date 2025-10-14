# Security Fix: Restrict File System Access in RPC Handlers

## Vulnerability Summary
The RPC handlers (`readFile`, `writeFile`, `listDirectory`, `getDirectoryTree`) in `src/modules/common/registerCommonHandlers.ts` currently allow unrestricted file system access to any authenticated client, enabling potential credential theft and data exfiltration.

**Current Issue**: Lines 186-391 in `registerCommonHandlers.ts` accept absolute paths and can read/write any file that the process has permissions to access.

## Implementation Plan

### 1. Create Path Security Utility (`src/modules/common/pathSecurity.ts`)

Create a new file with:

```typescript
import { resolve } from 'path';

export interface PathValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    // Resolve both paths to absolute paths to handle path traversal attempts
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // Check if the resolved target path starts with the working directory
    // This prevents access to files outside the working directory
    if (!resolvedTarget.startsWith(resolvedWorkingDir + '/') && resolvedTarget !== resolvedWorkingDir) {
        return {
            valid: false,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    return { valid: true };
}
```

### 2. Update `registerCommonHandlers` Function Signature

**File**: `src/modules/common/registerCommonHandlers.ts`

**Current signature** (line 134):
```typescript
export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager)
```

**New signature**:
```typescript
export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string)
```

### 3. Apply Path Validation to File Handlers

In `src/modules/common/registerCommonHandlers.ts`, update each handler:

#### `readFile` Handler (lines 186-198)
Add validation at the start:
```typescript
import { validatePath } from './pathSecurity';

rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data) => {
    logger.debug('Read file request:', data.path);

    // Validate path is within working directory
    const validation = validatePath(data.path, workingDirectory);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    try {
        const buffer = await readFile(data.path);
        // ... rest of handler
```

#### `writeFile` Handler (lines 200-258)
Add validation at the start:
```typescript
rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data) => {
    logger.debug('Write file request:', data.path);

    // Validate path is within working directory
    const validation = validatePath(data.path, workingDirectory);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    try {
        // ... rest of handler
```

#### `listDirectory` Handler (lines 260-310)
Add validation at the start:
```typescript
rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>('listDirectory', async (data) => {
    logger.debug('List directory request:', data.path);

    // Validate path is within working directory
    const validation = validatePath(data.path, workingDirectory);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    try {
        // ... rest of handler
```

#### `getDirectoryTree` Handler (lines 312-391)
Add validation at the start:
```typescript
rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>('getDirectoryTree', async (data) => {
    logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth);

    // Validate path is within working directory
    const validation = validatePath(data.path, workingDirectory);
    if (!validation.valid) {
        return { success: false, error: validation.error };
    }

    // ... rest of handler (starting with the helper function)
```

#### `bash` Handler (lines 136-184)
Add validation for the `cwd` parameter if provided:
```typescript
rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data) => {
    logger.debug('Shell command request:', data.command);

    // Validate cwd if provided
    if (data.cwd) {
        const validation = validatePath(data.cwd, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
    }

    try {
        // ... rest of handler
```

#### `ripgrep` Handler (lines 393-412)
Add validation for the `cwd` parameter if provided:
```typescript
rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async (data) => {
    logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);

    // Validate cwd if provided
    if (data.cwd) {
        const validation = validatePath(data.cwd, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
    }

    try {
        // ... rest of handler
```

#### `difftastic` Handler (lines 414-433)
Add validation for the `cwd` parameter if provided:
```typescript
rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>('difftastic', async (data) => {
    logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);

    // Validate cwd if provided
    if (data.cwd) {
        const validation = validatePath(data.cwd, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
    }

    try {
        // ... rest of handler
```

### 4. Update Call Sites

#### `src/api/apiSession.ts` (line 48)
**Current**:
```typescript
registerCommonHandlers(this.rpcHandlerManager);
```

**Updated**:
```typescript
registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);
```

#### `src/api/apiMachine.ts` (line 95)
Check the context and pass appropriate working directory. If there's no session context, you may need to handle this differently (possibly restrict or use a default safe directory).

### 5. Create Tests (`src/modules/common/pathSecurity.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { validatePath } from './pathSecurity';

describe('validatePath', () => {
    const workingDir = '/home/user/project';

    it('should allow paths within working directory', () => {
        expect(validatePath('/home/user/project/file.txt', workingDir).valid).toBe(true);
        expect(validatePath('file.txt', workingDir).valid).toBe(true);
        expect(validatePath('./src/file.txt', workingDir).valid).toBe(true);
    });

    it('should reject paths outside working directory', () => {
        const result = validatePath('/etc/passwd', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir).valid).toBe(true);
        expect(validatePath(workingDir, workingDir).valid).toBe(true);
    });
});
```

### 6. Run Tests

After implementation:
```bash
npm test -- pathSecurity.test.ts
```

## Key Security Controls

1. **Path Sandboxing**: All file operations restricted to session working directory using `path.resolve()` and `startsWith()` checks
2. **Path Traversal Protection**: Normalize and validate all paths to prevent `../../` style attacks

## Files to Modify

1. Create: `src/modules/common/pathSecurity.ts`
2. Modify: `src/modules/common/registerCommonHandlers.ts` (add workingDirectory parameter, import validatePath, apply to all handlers)
3. Modify: `src/api/apiSession.ts` (pass `this.metadata.path` to registerCommonHandlers)
4. Modify: `src/api/apiMachine.ts` (pass appropriate working directory)
5. Create: `src/modules/common/pathSecurity.test.ts`
