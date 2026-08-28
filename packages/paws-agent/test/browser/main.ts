import { PawsAgentClient } from '@wangjs-jacky/paws-agent';
import { BrowserCredentialProvider } from '@wangjs-jacky/paws-agent/browser';

declare global {
    interface Window {
        __PAWS_AGENT_VERIFY__?: string;
    }
}

void (async () => {
    const values = new Map<string, string>();
    const credentials = new BrowserCredentialProvider({
        get: async key => values.get(key) ?? null,
        set: async (key, value) => { values.set(key, value); },
        remove: async key => { values.delete(key); },
    });
    const client = new PawsAgentClient({
        serverUrl: 'https://paws.invalid',
        credentials,
    });
    await client.dispose();
    window.__PAWS_AGENT_VERIFY__ = 'ready';
})();
