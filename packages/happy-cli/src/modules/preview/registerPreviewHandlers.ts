import { exec } from 'child_process';
import { promisify } from 'util';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { scanCommonPorts } from '../preview/portScanner';
import { startHTTPDirectProxy } from '../proxy/startHTTPDirectProxy';
import { extractUrlsFromOutput } from './devServerDetector';
import { logger } from '@/ui/logger';

const execAsync = promisify(exec);

interface ScanPortsResponse {
    success: boolean;
    servers?: Array<{ port: number; title?: string }>;
    error?: string;
}

interface StartProxyRequest {
    targetUrl: string;
}

interface StartProxyResponse {
    success: boolean;
    proxyUrl?: string;
    error?: string;
}

interface DetectUrlsRequest {
    output: string;
}

interface DetectUrlsResponse {
    success: boolean;
    ports?: number[];
    error?: string;
}

interface SearchSourceRequest {
    selector: string;
    text: string;
    classes: string[];
}

interface SearchSourceResponse {
    success: boolean;
    sourceFile?: string;
    sourceLine?: number;
    error?: string;
}

// Store active proxy URLs so they can be referenced/stopped later
const activeProxies: string[] = [];

export function registerPreviewHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string) {

    // Scan common dev server ports on localhost
    rpcHandlerManager.registerHandler<Record<string, never>, ScanPortsResponse>('preview:scan-ports', async () => {
        try {
            const servers = await scanCommonPorts();
            return { success: true, servers };
        } catch (error) {
            logger.debug('preview:scan-ports failed:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to scan ports' };
        }
    });

    // Start an HTTP proxy to a target URL
    rpcHandlerManager.registerHandler<StartProxyRequest, StartProxyResponse>('preview:start-proxy', async (data) => {
        try {
            const proxyUrl = await startHTTPDirectProxy({ target: data.targetUrl });
            activeProxies.push(proxyUrl);
            return { success: true, proxyUrl };
        } catch (error) {
            logger.debug('preview:start-proxy failed:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to start proxy' };
        }
    });

    // Detect dev server URLs/ports from command output
    rpcHandlerManager.registerHandler<DetectUrlsRequest, DetectUrlsResponse>('preview:detect-urls', async (data) => {
        try {
            const ports = extractUrlsFromOutput(data.output);
            return { success: true, ports };
        } catch (error) {
            logger.debug('preview:detect-urls failed:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to detect URLs' };
        }
    });

    // Search source files for an element by class names or text content
    rpcHandlerManager.registerHandler<SearchSourceRequest, SearchSourceResponse>('preview:search-source', async (data) => {
        try {
            const rgTypeFlag = "--type-add 'web:*.{tsx,jsx,html,vue,svelte}' --type web";

            // First try: search for class name matches
            for (const className of data.classes) {
                if (!className) continue;

                try {
                    const { stdout } = await execAsync(
                        `rg -n "class.*${className}" ${rgTypeFlag}`,
                        { cwd: workingDirectory, timeout: 10000 }
                    );

                    const firstLine = stdout.trim().split('\n')[0];
                    if (firstLine) {
                        const match = firstLine.match(/^(.+?):(\d+):/);
                        if (match) {
                            return { success: true, sourceFile: match[1], sourceLine: parseInt(match[2], 10) };
                        }
                    }
                } catch {
                    // rg returns exit code 1 when no matches found, continue searching
                }
            }

            // Second try: search for text content
            if (data.text) {
                try {
                    const escapedText = data.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const { stdout } = await execAsync(
                        `rg -n "${escapedText}" ${rgTypeFlag}`,
                        { cwd: workingDirectory, timeout: 10000 }
                    );

                    const firstLine = stdout.trim().split('\n')[0];
                    if (firstLine) {
                        const match = firstLine.match(/^(.+?):(\d+):/);
                        if (match) {
                            return { success: true, sourceFile: match[1], sourceLine: parseInt(match[2], 10) };
                        }
                    }
                } catch {
                    // No matches found
                }
            }

            return { success: true, sourceFile: undefined, sourceLine: undefined };
        } catch (error) {
            logger.debug('preview:search-source failed:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to search source' };
        }
    });
}
