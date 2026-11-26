import { readFile } from 'node:fs/promises';
import { createStudio } from './server.mjs';
import { readCredential, secureOrigin } from './credentials.mjs';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const studio = await createStudio({ ...config, pawsOrigin: secureOrigin(config.pawsOrigin), publicOrigin: config.publicOrigin ? secureOrigin(config.publicOrigin) : undefined,
  webhookToken: await readCredential(config.webhookCredential), workerToken: await readCredential(config.workerCredential) });
console.log('原话卡片网站已启动：' + await studio.listen(config.port ?? 0, config.host ?? '127.0.0.1'));
process.once('SIGTERM', () => void studio.close()); process.once('SIGINT', () => void studio.close());
