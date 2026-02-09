import { env } from './env';

interface ToolCallPayload {
    gatewaySessionId: string;
    userId: string;
    appSessionId: string;
    functionName: string;
    parameters: Record<string, unknown>;
}

class ToolBridgeClient {
    private sessionBaseUrl: string | undefined;

    setSessionBaseUrl(url: string | undefined): void {
        this.sessionBaseUrl = url;
    }

    async execute(payload: ToolCallPayload): Promise<string> {
        const baseUrl = this.sessionBaseUrl || env.TOOL_BRIDGE_BASE_URL;
        if (!baseUrl) {
            return `error (tool bridge not configured for ${payload.functionName})`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), env.TOOL_BRIDGE_TIMEOUT_MS);

        try {
            const response = await fetch(`${baseUrl}/v1/voice/tool-call`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(env.TOOL_BRIDGE_API_KEY
                        ? { 'x-voice-bridge-key': env.TOOL_BRIDGE_API_KEY }
                        : {}),
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!response.ok) {
                const text = await response.text();
                return `error (tool bridge ${response.status}: ${text || 'unknown'})`;
            }

            const data = await response.json() as { result?: string };
            return data.result ?? 'done';
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `error (tool bridge request failed: ${message})`;
        } finally {
            clearTimeout(timeout);
        }
    }
}

export const toolBridgeClient = new ToolBridgeClient();
