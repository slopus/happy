import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = {
    serverUrl: string;
    homeDir: string;
    credentialPath: string;
};

export function loadConfig(): Config {
    // 与 happy-cli 保持同一 API 默认地址；网页入口继续使用单独的 HTTPS 地址。
    const serverUrl = (process.env.HAPPY_SERVER_URL ?? 'http://47.115.228.20:3005').replace(/\/+$/, '');
    const homeDir = process.env.HAPPY_HOME_DIR ?? join(homedir(), '.happy');
    const credentialPath = join(homeDir, 'agent.key');
    return { serverUrl, homeDir, credentialPath };
}
