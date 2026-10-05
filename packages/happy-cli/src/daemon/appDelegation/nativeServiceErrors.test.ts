import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRestrictedCodex } from './restrictedCodex';
import { codexServiceError } from './nativeServiceErrors';
for (const [error, expected] of [
    [{codexErrorInfo:'usageLimitExceeded'},'quota-exhausted'],
    [{codexErrorInfo:'unauthorized'},'account-login-required'],
    [{code:-32601},'protocol-incompatible'],
    [{code:-32602},'parameter-unsupported'],
    [{message:'quota login model_not_found /secret/token'},'execution-interrupted'],
] as const) it(`sanitizes native Codex failure ${expected}`, async () => {
    const dir=await mkdtemp(join(tmpdir(),'codex-error-')), binary=join(dir,'codex');
    try {
        await writeFile(binary, `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 0.159.3');process.exit(0)}
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
if(m.method==='turn/start'){console.log(JSON.stringify({id:m.id,result:{}}));console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'failed',error:${JSON.stringify(error)}}}}));}
else if(m.method==='initialize'&&${JSON.stringify(error)}.code)console.log(JSON.stringify({id:m.id,error:${JSON.stringify(error)}}));
else console.log(JSON.stringify({id:m.id,result:{thread:{id:'t'}}}));});`,{mode:0o700});
        await expect(runRestrictedCodex(binary,dir,dir,[{role:'user',text:'hi'}],new AbortController().signal,()=>{},undefined,'gpt-6-astra')).rejects.toThrow(expected);
    } finally { await rm(dir,{recursive:true,force:true}); }
});
it('does not classify unsupported Codex fields or arbitrary HTTP status',()=>{
    expect(codexServiceError({code:'model_not_found',data:{message:'usageLimitExceeded'},httpStatusCode:401})).toBe('execution-interrupted');
});
