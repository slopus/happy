import { createServer } from 'node:http';
import axios from 'axios';
import { it, expect } from 'vitest';
import { PawsHttpTransport } from '../transport/http';
import { SessionsResourceImpl } from './sessions';
import { RecordEncryptionStore } from '../crypto/records';
import { decodeBase64, decryptLegacy, encodeBase64, encryptLegacy } from '../crypto/encryption';

it('writes App-compatible encrypted settings over HTTP, handles concurrent edits and binds account identity', async () => {
    const account = {token:'fixture',secret:new Uint8Array(32).fill(8),contentKeyPair:{publicKey:new Uint8Array(32),secretKey:new Uint8Array(32)}};
    let credentials=account, version=0, posts=0;
    let settings:any={theme:'dark'};
    const server=createServer(async(req,res)=>{
        const reply=(body:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
        if(req.headers.authorization!=='Bearer fixture')return reply({},401);
        if(req.url==='/v2/sessions/s')return reply({session:{id:'s',metadata:encodeBase64(encryptLegacy({machineId:'m'},account.secret)),agentState:null,dataEncryptionKey:null}});
        if(req.url!=='/v1/account/settings')return reply({},404);
        if(req.method==='GET')return reply({settings:encodeBase64(encryptLegacy(settings,account.secret)),settingsVersion:version});
        posts++;let body='';for await(const chunk of req)body+=chunk;
        expect(body).not.toContain('MISS');
        const payload=JSON.parse(body);
        if(posts===1){settings={...settings,concurrent:{keep:true}};version++;}
        if(payload.expectedVersion!==version)return reply({success:false,error:'version-mismatch',currentVersion:version,currentSettings:encodeBase64(encryptLegacy(settings,account.secret))});
        settings=decryptLegacy(decodeBase64(payload.settings),account.secret);version++;
        reply({success:true,version});
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('missing address');
    const http=new PawsHttpTransport({serverUrl:`http://127.0.0.1:${address.port}`,client:axios.create({proxy:false}),credentials:{getCredentials:async()=>credentials,setCredentials:async()=>{},clearCredentials:async()=>{}}});
    const sdk=new SessionsResourceImpl(http,{} as never,new RecordEncryptionStore(),async()=>[]);
    try {
        const assignment=await sdk.organize('s',{listName:'MISS',tagNames:['视频采集']});
        expect(posts).toBe(2);
        expect(settings.theme).toBe('dark');expect(settings.concurrent.keep).toBe(true);
        expect((await sdk.getOrganization()).sessions.s).toEqual(assignment);
        expect(settings.sidebarOrganization.lists[0]).toMatchObject({kind:'workspace',machineId:null,path:null,defaultAgent:null,color:'blue',name:'MISS'});
        credentials={...account,token:'switched'};
        await expect(http.post('/v1/account/settings',{},{expectedCredentials:account})).rejects.toMatchObject({code:'AUTH_EXPIRED'});
        expect(posts).toBe(2);
    }finally{http.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
