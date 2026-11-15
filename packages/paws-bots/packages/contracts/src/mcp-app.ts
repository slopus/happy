import * as z from "zod";

/** The MCP Apps extension (SEP-1865): a tool names a `ui://` resource that shows its result. */
export const MCP_APP_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** The stable revision of the view-to-host protocol this host speaks. */
export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";

/** Larger app documents are not shown; the tool's result still reaches the bot. */
export const MCP_APP_HTML_MAX_BYTES = 2_000_000;
/** The tool result an app card carries for its view; a larger one keeps only its structured part. */
export const MCP_APP_RESULT_MAX_BYTES = 256_000;
/** The arguments an app card carries; larger ones are left out of the card. */
export const MCP_APP_ARGUMENTS_MAX_BYTES = 64_000;
/** How long the bot's turn waits for an app after its call returned. */
export const MCP_APP_READ_TIMEOUT_MS = 10_000;
export const MCP_APP_DOMAINS_MAX = 32;

const Domains = z.array(z.string().max(256)).max(MCP_APP_DOMAINS_MAX);

/** Origins the app declared it needs, already narrowed to the ones this host allows. */
export const McpAppCspSchema = z.object({
  connectDomains: Domains.optional(),
  resourceDomains: Domains.optional(),
});
export type McpAppCsp = z.infer<typeof McpAppCspSchema>;
