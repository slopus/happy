import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

type CodexSteerRpcResult = { success: true } | { success: false; error: string };
type CodexSteerRpcHandler = (params: Record<string, unknown>) => Promise<CodexSteerRpcResult>;

type CodexSteerHandlerInput = {
    client: {
        steerTurn(text: string): Promise<void>;
    };
    session: {
        rpcHandlerManager: {
            registerHandler(method: string, handler: CodexSteerRpcHandler): void;
        };
        sendSessionProtocolMessage(envelope: SessionEnvelope): void;
    };
    onFailure(message: string): void;
    admit?: <T>(work: () => Promise<T>) => Promise<T>;
    /** A managed Cloud run: steering is refused before the turn is touched. */
    managedRun?: boolean;
};

export function registerCodexSteerHandler(input: CodexSteerHandlerInput): void {
    input.session.rpcHandlerManager.registerHandler('steer', async (params) => {
        if (input.managedRun) {
            // A managed run answers exactly the prompt its envelope was admitted
            // for. Steering and setting a goal are free-text instructions that
            // reach the provider outside that admission — steering is injected
            // into the turn already running, and a goal is carried into every turn
            // after it. Refused before the provider or the queue is touched;
            // clearing a goal removes an instruction rather than adding one, so it
            // stays. Permission answers are bound to a request this run is already
            // waiting on and are untouched.
            return { success: false, error: 'A managed run cannot be steered' };
        }
        const text = typeof params?.text === 'string' ? params.text : '';
        if (!text.trim()) {
            return { success: false, error: 'Steer text is required' };
        }

        try {
            const work = async () => {
                await input.client.steerTurn(text);
                input.session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }));
                return { success: true as const };
            };
            return await (input.admit ? input.admit(work) : work());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            input.onFailure(message);
            return { success: false, error: message };
        }
    });
}
