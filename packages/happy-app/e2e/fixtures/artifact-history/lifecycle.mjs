/** Stop/start only this fixture's daemon, preserving account, machine identity and store. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const r=JSON.parse(await fs.readFile(new URL('../../../test-results/artifact-history/runtime.json',import.meta.url),'utf8'));
assert(r.home.startsWith(root+'/environments/data/envs/'));assert(r.serverUrl.startsWith('http://localhost:'));assert(['offline','online'].includes(process.argv[2]));
const env={...process.env,HAPPY_HOME_DIR:r.home,HAPPY_SERVER_URL:r.serverUrl,HAPPY_WEBAPP_URL:r.webUrl,CODEX_HOME:r.codexHome,HAPPY_CODEX_PATH:'/Users/jacky/.local/bin/codex',HAPPY_CODEX_APP_SERVER_MODE:'spawn'};
for(const name of Object.keys(env))if(name==='CLAUDECODE'||name.startsWith('HAPPY_CODEX_ACCOUNT_')||name.startsWith('HAPPY_CODEX_SESSION_'))delete env[name];
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'packages/happy-cli/bin/happy.mjs'),'daemon',process.argv[2]==='offline'?'stop':'start'],{cwd:root,env,stdio:'ignore'});child.once('exit',code=>code===0?resolve():reject(new Error('Isolated lifecycle command failed')));child.once('error',reject);});
console.log(JSON.stringify({action:process.argv[2],isolated:true,preservedIdentity:true}));
