import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpAppServer, loadAppHtml, startMcpAppFixture } from './server.js';

async function main(): Promise<void> {
    if (process.argv.includes('--stdio')) {
        await createMcpAppServer(await loadAppHtml()).connect(new StdioServerTransport());
        return;
    }
    const port = Number.parseInt(process.env.PORT ?? '3107', 10);
    const fixture = await startMcpAppFixture({ port });
    console.log(`Paws MCP App fixture listening at ${fixture.mcpUrl}`);

    const shutdown = async () => {
        await fixture.close();
        process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'MCP App fixture failed');
    process.exitCode = 1;
});
