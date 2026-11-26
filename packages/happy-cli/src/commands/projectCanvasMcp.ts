import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { callDaemonProjectCanvas } from '@/daemon/controlClient';
import { registerProjectCanvasTools } from '@/modules/goalBoard/projectCanvasTools';

export async function runProjectCanvasMcp(args: string[]): Promise<void> {
    if (args.length !== 2 || args[0] !== '--project' || !isAbsolute(args[1])) {
        throw new Error('Usage: paws canvas-mcp --project <absolute Goal First project path>');
    }
    const projectPath = args[1];
    const server = new McpServer({ name: 'Paws Project Canvas', version: '1.0.0' });
    registerProjectCanvasTools(server, command => callDaemonProjectCanvas({ projectPath, command }), false);
    await server.connect(new StdioServerTransport());
}
