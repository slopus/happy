// Local synthetic application only. Receipts stay in this server process.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createAIServiceClient,createNodePlatformTransport,createPlatformServiceHandler,createMemoryServiceStorage} from '@wangjs-jacky/paws-agent/services/node';
export async function startSmokeApp({serverUrl,receipt,port=4193,appId='ai-service-smoke'}={}) {
    if(appId!=='ai-service-smoke' || !['127.0.0.1','localhost'].includes(new URL(serverUrl).hostname)) throw new Error('Local fixture required');
    const client=createAIServiceClient({appId,transport:createNodePlatformTransport({appId,serverUrl,receipt,storage:createMemoryServiceStorage()})});
    const bindings=new Map(),conversations=new Set(),session=randomUUID();
    const bridge=createPlatformServiceHandler(client,{
        async authorize(op,context){return context===session && op.operation!=='revoke' && (!op.bindingId || bindings.has(op.bindingId)) && (op.operation!=='find' || conversations.has(op.appConversationId));},
        async registerConversation(binding,id){bindings.set(binding.id,binding);if(id)conversations.add(id);},
        async resolveBinding(id){return bindings.get(id);}
    });
    const html=await readFile(new URL('index.html',import.meta.url),'utf8');
    const source=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    const bundle=await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('.',import.meta.url)),sourcefile:'smoke-client.js'},bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});
    const css=await readFile(createRequire(import.meta.url).resolve('@wangjs-jacky/paws-connect-ui/panel.css'));
    const server=createServer(async(req,res)=>{
        const send=(status,body,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type==='application/json'?JSON.stringify(body):body);};
        try {
            const origin='http://127.0.0.1:'+server.address().port;
            if(req.headers.host!==new URL(origin).host)return send(403,{error:'local-host-required'});
            if(req.method==='GET' && req.url==='/'){res.setHeader('Set-Cookie',`smoke-session=${session}; HttpOnly; SameSite=Strict; Path=/`);return send(200,html.replace(/<script type="module">[\s\S]*?<\/script>/,'<script type="module" src="/bundle.js"></script>'),'text/html; charset=utf-8');}
            if(req.method==='GET' && req.url==='/bundle.js')return send(200,bundle.outputFiles[0].text,'text/javascript');
            if(req.method==='GET' && req.url==='/panel.css')return send(200,css,'text/css');
            if(!req.url.startsWith('/api/service/'))return send(404,{error:'not-found'});
            if(!(req.headers.cookie||'').split(';').some(value=>value.trim()===`smoke-session=${session}`) || req.headers['x-smoke-app']!==appId || (req.headers.origin && req.headers.origin!==origin))return send(403,{error:'permission-denied'});
            let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)return send(413,{error:'invalid-request'});}
            const response=await bridge({method:req.method,path:req.url.slice('/api/service'.length),body:raw?JSON.parse(raw):undefined},session);
            for(const [key,value] of Object.entries(response.headers))res.setHeader(key,value);
            send(response.status,response.body);
        } catch { send(400,{error:{code:'invalid-request',retryable:false}}); }
    });
    await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
    return {url:'http://127.0.0.1:'+server.address().port,client,async close(){client.dispose();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
    console.error('Start the isolated server fixture with the command in docs/verification/shared-ai-services.md. No credentials are loaded from disk.');
    process.exitCode=1;
}
