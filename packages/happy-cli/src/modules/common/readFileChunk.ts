import { open } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { validateMachineReadPath } from './machineReadPath';

export function createReadFileChunkHandler(cwd: string, home: string) {
    return async (input: { path: string; offset: number; length: number; revision?: string; scopeRoot?: string }) => {
        try {
            if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.length) || input.length < 1 || input.length > 256 * 1024) throw new Error('Invalid read range');
            const validation = await validateMachineReadPath(input.path, cwd, home);
            if (!validation.valid) throw new Error(validation.error);
            if (input.scopeRoot !== undefined) {
                const scope = await validateMachineReadPath(input.scopeRoot, cwd, home);
                if (!scope.valid) throw new Error(scope.error);
                const child = relative(scope.resolvedPath!, validation.resolvedPath!);
                if (isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) throw new Error('Media outside preview scope');
            }
            const file = await open(validation.resolvedPath!, 'r');
            try {
                const stat = await file.stat();
                if (!stat.isFile() || input.offset > stat.size) throw new Error('Invalid file range');
                const revision = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
                if (input.revision !== undefined && input.revision !== revision) throw new Error('File changed during read');
                const bytes = Buffer.alloc(Math.min(input.length, stat.size - input.offset));
                let offset = 0;
                while (offset < bytes.length) {
                    const result = await file.read(bytes, offset, bytes.length - offset, input.offset + offset);
                    if (!result.bytesRead) throw new Error('File changed during read');
                    offset += result.bytesRead;
                }
                const after = await file.stat();
                if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== revision) throw new Error('File changed during read');
                return { success: true as const, content: bytes.toString('base64'), offset: input.offset, totalSize: stat.size, revision };
            } finally { await file.close(); }
        } catch (error) {
            return { success: false as const, error: error instanceof Error ? error.message : 'Unable to read file range' };
        }
    };
}
