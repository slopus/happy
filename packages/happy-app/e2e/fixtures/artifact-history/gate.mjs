/** A single filesystem barrier keeps a real native tool active for exclusion assertions. */
import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const runtime=JSON.parse(await fs.readFile(new URL('../../../test-results/artifact-history/runtime.json',import.meta.url),'utf8'));
const ready=path.join(runtime.project,'.acceptance-waiting');const release=path.join(runtime.project,'.acceptance-release');
if(process.argv[2]==='prepare'){
 await Promise.all([fs.rm(ready,{force:true}),fs.rm(release,{force:true})]);
 await fs.writeFile(path.join(runtime.project,'.acceptance-gate.cjs'),`const fs=require('node:fs');const release='.acceptance-release';const watcher=fs.watch('.',()=>{if(fs.existsSync(release)){clearTimeout(deadline);watcher.close();console.log('GATE RELEASED');}});const deadline=setTimeout(()=>{watcher.close();process.exitCode=1;console.error('GATE TIMEOUT');},120000);fs.writeFileSync('.acceptance-waiting','ready');if(fs.existsSync(release)){clearTimeout(deadline);watcher.close();console.log('GATE RELEASED');}`);
 console.log('Native barrier prepared');
}else{
 await new Promise((resolve,reject)=>{const watcher=watch(runtime.project,async()=>{try{await fs.access(ready);clearTimeout(timer);watcher.close();resolve();}catch{}});const timer=setTimeout(()=>{watcher.close();reject(new Error('Native barrier did not start'));},120000);fs.access(ready).then(()=>{clearTimeout(timer);watcher.close();resolve();}).catch(()=>{});});
 try {await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./boundaries.mjs',import.meta.url)),'active'],{stdio:'inherit'});child.once('exit',code=>code===0?resolve():reject(new Error('Active writer assertion failed')));child.once('error',reject);});}
 finally{await fs.writeFile(release,'release');}
}
