import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const roots=['/Users/jacky/jacky-github/happy--shared-ai-services/examples/ai-service-smoke','/Users/jacky/jacky-github/relationship-advisor--paws-services'];
for(const root of roots){
 const require=createRequire(resolve(root,'package.json'));
 const manifest=require('@wangjs-jacky/paws-agent/package.json');
 for(const subpath of ['services','services/browser','services/node']){
  const esm=await import(pathToFileURL(resolve(root,'node_modules/@wangjs-jacky/paws-agent',manifest.exports['./'+subpath].import.default)).href);
  const cjs=require('@wangjs-jacky/paws-agent/'+subpath);
  for(const api of [esm,cjs]){
   assert.equal(typeof api.createAIServiceClient,'function');
   assert.equal(typeof api.validateServiceMessages,'function');
   assert.equal(new api.AIServiceClientError('model-unavailable',false,'request','not-submitted').submission,'not-submitted');
  }
  console.log(root+' '+subpath+': ESM/CJS public exports passed');
 }
}
