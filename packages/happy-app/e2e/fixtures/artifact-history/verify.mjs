/** Read-back evidence from the real isolated daemon, never a replacement version store. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const output=new URL('../../../test-results/artifact-history/',import.meta.url);
const runtime=JSON.parse(await fs.readFile(new URL('runtime.json',output),'utf8'));
const replay=process.argv[2]==='replay'?JSON.parse(await fs.readFile(new URL('replay.json',output),'utf8')):null;
const project=replay?.project??runtime.project;
async function rpc(method,input){const response=await fetch(runtime.controllerUrl+'/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,input})});assert(response.ok);const result=await response.json();assert(result.ok,JSON.stringify(result.error));return result.value;}
const catalog=await rpc('artifactCatalog',{root:project});assert.equal(catalog.length,1);
const evidence=[];
for(const artifact of catalog[0].artifacts){
 const ref={workspaceId:artifact.workspaceId,artifactId:artifact.id};
 const {versions}=await rpc('artifactVersions',ref);const bySequence=Object.fromEntries(versions.map(v=>[v.sequence,v]));
 assert(versions.length>=5,'Complete native V1–V5 path required');
 assert.equal(bySequence[1].source,'baseline');assert.equal(bySequence[2].source,'ai');assert.equal(bySequence[3].source,'ai');assert.equal(bySequence[4].source,'restore');assert.equal(bySequence[5].source,'ai');
 assert.equal(bySequence[4].restoreFromVersionId,bySequence[1].id);
 const original=await rpc('artifactRead',{...ref,versionId:bySequence[1].id});const restored=await rpc('artifactRead',{...ref,versionId:bySequence[4].id});assert.deepEqual(restored.manifest,original.manifest);assert.equal(restored.entryContent,original.entryContent);
 const fifth=await rpc('artifactRead',{...ref,versionId:bySequence[5].id});assert.match(fifth.entryContent,/(?:NATIVE|REPLAY) (?:MD|HTML) V5/);
 const current=await rpc('artifactRead',ref);assert.equal(current.workingState,'clean');
 for(const file of current.manifest.files){const bytes=await fs.readFile(path.join(project,file.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);assert.equal(bytes.length,file.size);}
 evidence.push({format:artifact.kind,sequences:versions.map(v=>({sequence:v.sequence,source:v.source})),currentSequence:versions.find(v=>v.id===current.artifact.currentVersionId)?.sequence,restoredFiles:restored.manifest.files.map(f=>({path:f.path,sha256:f.sha256})),currentFiles:current.manifest.files.map(f=>({path:f.path,sha256:f.sha256})),exactV1Restoration:true,currentDiskMatches:true});
}
const result={date:new Date().toISOString(),boundaries:runtime.boundaries,evidence};await fs.writeFile(new URL(replay?'replay-readback.json':'readback-final.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
