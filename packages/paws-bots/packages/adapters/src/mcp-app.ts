import type { ClientCapabilities, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorApp } from "@rakazo/adapter-kit";
import {
  MCP_APP_ARGUMENTS_MAX_BYTES,
  MCP_APP_EXTENSION,
  MCP_APP_HTML_MAX_BYTES,
  MCP_APP_MIME_TYPE,
  MCP_APP_RESULT_MAX_BYTES,
} from "@rakazo/contracts";
import { mcpAppCsp, redactSecrets } from "@rakazo/core";

/** Told to every MCP server at initialize: this client shows apps (MCP Apps, SEP-1865). */
export const MCP_APP_CLIENT_CAPABILITIES: ClientCapabilities = {
  extensions: { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
};

type ToolUiMeta = { resourceUri?: unknown; visibility?: unknown };

function toolUiMeta(tool: Pick<Tool, "_meta">): ToolUiMeta {
  const ui = tool._meta?.ui;
  return ui && typeof ui === "object" ? (ui as ToolUiMeta) : {};
}

/** Whether the model may see a tool. A tool only the server's own app calls stays hidden. */
export function mcpToolVisibleToModel(tool: Pick<Tool, "_meta">): boolean {
  const { visibility } = toolUiMeta(tool);
  return !Array.isArray(visibility) || visibility.includes("model");
}

/** The `ui://` resource a tool shows its result with, if it names one. */
export function mcpToolAppResourceUri(tool: Pick<Tool, "_meta">): string | undefined {
  const { resourceUri } = toolUiMeta(tool);
  // The flat key is the spec's deprecated spelling; servers still send it.
  const uri = resourceUri ?? tool._meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") && uri.length <= 2048 ? uri : undefined;
}

type ReadResult = { contents?: unknown };
type ResourceContent = {
  uri?: unknown;
  mimeType?: unknown;
  text?: unknown;
  blob?: unknown;
  _meta?: { ui?: { csp?: unknown; prefersBorder?: unknown } };
};

/**
 * The app a resource read returned, or undefined when it is not one this host shows: another
 * type, another URI, or too large. An app is never worth failing the call it belongs to.
 */
export function mcpAppFromResource(
  server: string,
  uri: string,
  read: ReadResult,
): ConnectorApp | undefined {
  const contents = Array.isArray(read.contents) ? (read.contents as ResourceContent[]) : [];
  const content = contents.find((item) => item?.uri === uri);
  if (!content || content.mimeType !== MCP_APP_MIME_TYPE) return undefined;
  const html =
    typeof content.text === "string"
      ? content.text
      : typeof content.blob === "string"
        ? Buffer.from(content.blob, "base64").toString("utf8")
        : undefined;
  if (!html || Buffer.byteLength(html) > MCP_APP_HTML_MAX_BYTES) return undefined;
  const ui = content._meta?.ui;
  return {
    server,
    html,
    csp: mcpAppCsp(ui?.csp),
    ...(typeof ui?.prefersBorder === "boolean" ? { prefersBorder: ui.prefersBorder } : {}),
  };
}

/**
 * Reads the app for a call that succeeded. A failed read only means no app: the call's result
 * already reached the bot. The connection's credentials are redacted from the document, as they
 * are from the result, in case the server echoes them.
 */
export async function readMcpApp(
  server: string,
  uri: string | undefined,
  result: unknown,
  read: (uri: string) => Promise<ReadResult>,
  secrets: readonly string[] = [],
): Promise<ConnectorApp | undefined> {
  if (!uri || !result || typeof result !== "object") return undefined;
  if ((result as { isError?: unknown }).isError === true) return undefined;
  try {
    const app = mcpAppFromResource(server, uri, await read(uri));
    return app && { ...app, html: redactSecrets(app.html, secrets) };
  } catch {
    return undefined;
  }
}

/**
 * The tool result an app's view receives, within the card's budget: whole when it fits,
 * otherwise only its structured part, otherwise empty. The bot's copy is unaffected.
 */
export function mcpAppViewResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return { content: [] };
  const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value)) <= MCP_APP_RESULT_MAX_BYTES;
  const whole = result as Record<string, unknown>;
  const { content, structuredContent, isError, _meta } = whole;
  const envelope = {
    content: Array.isArray(content) ? content : [],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(isError === true ? { isError } : {}),
    ...(_meta !== undefined ? { _meta } : {}),
  };
  if (fits(envelope)) return envelope;
  const structured = {
    content: [],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
  return fits(structured) ? structured : { content: [] };
}

/** The call's arguments as the view receives them: whole when small, otherwise left out. */
export function mcpAppViewArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Buffer.byteLength(JSON.stringify(args)) <= MCP_APP_ARGUMENTS_MAX_BYTES ? args : {};
}
