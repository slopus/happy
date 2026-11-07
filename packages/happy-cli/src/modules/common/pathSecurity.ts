import { resolve, sep } from 'path';

export interface PathValidationResult {
    valid: boolean;
    resolvedPath?: string;
    error?: string;
}

/**
 * 验证路径是否在允许的工作目录内
 * @param targetPath - 要验证的路径（可以是相对路径或绝对路径）
 * @param workingDirectory - 会话的工作目录（必须是绝对路径）
 * @returns 验证结果
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    // 将两条路径都解析为绝对路径以处理路径遍历尝试
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // 检查解析后的目标路径是否以工作目录开头
    // 使用 path.sep 在 Windows (\) 和 Unix (/) 上都能正确工作
    if (!resolvedTarget.startsWith(resolvedWorkingDir + sep) && resolvedTarget !== resolvedWorkingDir) {
        return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    return { valid: true, resolvedPath: resolvedTarget };
}

/**
 * 只读访问校验：相对路径仍相对 workingDirectory 解析（保持既有调用行为），
 * 允许读取 containmentRoot（本项目传机器 HOME）以及会话工作目录。
 * 用于 readFile / listDirectory / getDirectoryTree，兼容工作目录位于
 * 外置盘等 HOME 之外的位置；写入与命令执行仍走 validatePath。
 *
 * @param targetPath - 要验证的路径（可以是相对路径或绝对路径）
 * @param workingDirectory - 会话的工作目录（用于解析相对路径）
 * @param containmentRoot - 允许访问的根目录（通常是机器 HOME）
 * @returns 验证结果
 */
export function validateReadPath(
    targetPath: string,
    workingDirectory: string,
    containmentRoot: string,
): PathValidationResult {
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const roots = [resolve(containmentRoot), resolve(workingDirectory)];

    if (!roots.some(root => resolvedTarget === root || resolvedTarget.startsWith(root.endsWith(sep) ? root : root + sep))) {
        return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Access denied: Path '${targetPath}' is outside the allowed root`,
        };
    }

    return { valid: true, resolvedPath: resolvedTarget };
}
