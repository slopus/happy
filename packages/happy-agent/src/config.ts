import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
    serverUrl: string;
    homeDir: string;
    credentialPath: string;
};

export function loadConfig(): Config {
    const serverUrl = (process.env.HAPPY_SERVER_URL ?? 'http://192.144.133.93:3000').replace(/\/+$/, '');
    const homeDir = process.env.HAPPY_HOME_DIR ?? join(homedir(), '.happy');
    const credentialPath = join(homeDir, 'agent.key');
    return { serverUrl, homeDir, credentialPath };
}
