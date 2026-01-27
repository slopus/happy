import { logger } from '@/ui/logger';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { run as runDifftastic } from '@/integrations/difftastic/index';
import { validatePath } from './pathSecurity';
import { RPC_METHODS } from '@happy/protocol/rpc';

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

export function registerDifftasticHandler(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    // Difftastic handler - raw interface to difftastic
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>(RPC_METHODS.DIFFTASTIC, async (data) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
        }

        try {
            const result = await runDifftastic(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run difftastic:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run difftastic'
            };
        }
    });
}
