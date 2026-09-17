import { createPocServer } from '../dist/server.mjs';
import { createProductionGateway, PRODUCTION_ORIGIN } from './production-gateway.mjs';
import { readFile } from 'node:fs/promises';

const dataDir = process.env.PAWS_AGENT_PARTY_DATA_DIR ?? '/var/lib/paws-agent-party';
const accessToken = process.env.PAWS_AGENT_PARTY_ACCESS_TOKEN;
if (!accessToken || !/^[A-Za-z0-9_-]{43,128}$/.test(accessToken)) throw Error('A strong AgentParty access token is required');
const revision = (await readFile(new URL('../dist/revision', import.meta.url), 'utf8')).trim();
const backend = await createPocServer({ dataDir, accessToken, staticDir: new URL('../dist/web/', import.meta.url).pathname });
let gateway;
try { gateway = await createProductionGateway({ backendUrl: backend.url, revision }); }
catch (error) { await backend.close(); throw error; }
console.log(`AgentParty ${revision}: ${PRODUCTION_ORIGIN}/agent-party/`);
let stopping;
const stop = () => {
  stopping ??= gateway.close().then(() => backend.close()).then(() => { process.exitCode = 0; });
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
