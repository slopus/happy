import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadFileChunkHandler } from './readFileChunk';
let root: string;
afterEach(async () => { if(root) await rm(root,{recursive:true,force:true}); });
it('bounds each response, preserves bytes and rejects stale revisions or invalid ranges', async () => {
 root=await mkdtemp(join(tmpdir(),'read-chunk-'));const path=join(root,'film.mp4');const data=Buffer.alloc(700000,37);await writeFile(path,data);
 const read=createReadFileChunkHandler(root,root);const first=await read({path,offset:0,length:256*1024});
 expect(first.success).toBe(true);if(!first.success)throw Error(first.error);
 expect(first.totalSize).toBe(data.length);expect(Buffer.from(first.content,'base64')).toEqual(data.subarray(0,256*1024));
 expect(await read({path,offset:-1,length:1})).toMatchObject({success:false});
 expect(await read({path,offset:0,length:256*1024+1})).toMatchObject({success:false});
 await writeFile(path,Buffer.alloc(10));expect(await read({path,offset:0,length:10,revision:first.revision})).toMatchObject({success:false});
 const scope=join(root,'scope');await mkdir(scope);await symlink(path,join(scope,'escape.mp4'));expect(await read({path:join(scope,'escape.mp4'),scopeRoot:scope,offset:0,length:10})).toMatchObject({success:false});
 expect(await read({path:'/etc/passwd',offset:0,length:10})).toMatchObject({success:false});
});
