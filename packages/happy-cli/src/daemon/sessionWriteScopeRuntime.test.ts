import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import * as sandboxPolicy from '@/sandbox/sandboxPolicy';
import { SandboxConfigSchema } from '@/persistence';
import { configuration } from '@/configuration';
import { createSessionWriteScopeRuntime, isSessionWriteScopeLaunch, supportsSessionWriteScopePlatform } from './sessionWriteScopeRuntime';
import { decisionBytes, type ScopeDecision, type ScopeRequest } from './sessionWriteScope';
import { captureSaycodeAgentEnvironment } from './sessionEnv';
import { createPortRegistry } from './portRegistry';
import { startDaemonControlServer } from './controlServer';
import type { TrackedSession } from './types';

vi.mock('@/configuration', async importOriginal => {
  const original = await importOriginal<typeof import('@/configuration')>();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  return { ...original, configuration: { ...original.configuration, happyHomeDir: mkdtempSync(join(tmpdir(), 'scope-runtime-')) } };
});

it('keeps mandatory machine policy on its existing UID/managed enforcement path', async () => {
  const policy = vi.spyOn(sandboxPolicy, 'readMachineSandboxPolicyMode').mockReturnValue('mandatory');
  try {
    expect(await createSessionWriteScopeRuntime({ machineId: 'machine', env: { HAPPY_WRITE_SCOPE_HOST_VERSION: '1' }, managed: false,
      findSession: () => undefined, preserve: () => true, resume: async () => ({ type: 'success' }),
    })).toBeNull();
  } finally { policy.mockRestore(); }
});

it('advertises Linux only after actual namespace capability and never treats Windows as protected', async () => {
  const probe = vi.fn(async () => true);
  expect(await supportsSessionWriteScopePlatform('win32', probe)).toBe(false);
  expect(await supportsSessionWriteScopePlatform('darwin', probe)).toBe(true);
  expect(probe).not.toHaveBeenCalled();
  expect(await supportsSessionWriteScopePlatform('linux', probe)).toBe(true);
  expect(await supportsSessionWriteScopePlatform('linux', async () => false)).toBe(false);
  expect(await supportsSessionWriteScopePlatform('linux', async () => { throw new Error('denied'); })).toBe(false);
});

it('keeps checkpoint, credential-staged, unprotected and unsupported-provider launches on their existing paths', () => {
  const sandboxConfig = JSON.stringify(SandboxConfigSchema.parse({}));
  expect(isSessionWriteScopeLaunch({ provider: 'codex', sandboxConfig })).toBe(true);
  expect(isSessionWriteScopeLaunch({ provider: 'claude', sandboxConfig })).toBe(true);
  for (const input of [{ provider: 'gemini', sandboxConfig }, { provider: 'codex', sandboxConfig, userHomeDir: '/staged' },
    { provider: 'codex', sandboxConfig: '{"enabled":false}' }, { provider: 'codex', sandboxConfig: 'invalid' },
    { provider: 'codex', sandboxConfig: JSON.stringify({ ...JSON.parse(sandboxConfig), checkpointProtection: {
      secretPatterns: [], maxFileBytes: 1000, maxFiles: 10, maxTotalBytes: 10000,
    } }) }]) {
    expect(isSessionWriteScopeLaunch(input)).toBe(false);
  }
});

describe.skipIf(!['darwin', 'linux'].includes(process.platform) || (process.platform === 'linux' && process.env.HAPPY_SCOPE_NATIVE_LINUX !== '1') || (process.env.HAPPY_SCOPE_NATIVE_CODEX !== '1' && process.env.HAPPY_SCOPE_NATIVE_CLAUDE !== '1'))('native owned scope runtime/control integration', () => {
  it.each([...(process.env.HAPPY_SCOPE_NATIVE_CODEX === '1' ? ['codex'] : []), ...(process.env.HAPPY_SCOPE_NATIVE_CLAUDE === '1' ? ['claude'] : [])])('binds %s reports, replaces once after owned exit/receipt, and revokes', async (provider) => {
    await mkdir(configuration.happyHomeDir, { recursive: true });
    const fixture = await mkdtemp(join(userInfo().homedir, '.scope-runtime-'));
    const project = join(fixture, 'project'), root = join(fixture, 'tools'), home = join(fixture, 'home');
    await Promise.all([project, root, home, join(fixture, 'codex')].map(path => mkdir(path)));
    const config = SandboxConfigSchema.parse({ sessionIsolation: 'strict', denyWritePaths: [join(fixture, 'protected')] });
    const keys = generateKeyPairSync('ed25519'), publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    let target: TrackedSession | undefined, baseUrl = '', secret = '';
    const children: ChildProcess[] = []; let preserved = 0;
    const runtime = (await createSessionWriteScopeRuntime({ machineId: 'machine', managed: false,
      env: { HAPPY_WRITE_SCOPE_HOST_VERSION: '1', HAPPY_WRITE_SCOPE_HOST_PUBLIC_KEY: publicPem,
        HAPPY_WRITE_SCOPE_HOST_ACCOUNT_ID: 'account', HAPPY_WRITE_SCOPE_HOST_INCARNATION: 'host' },
      findSession: id => id === 'session' ? target : undefined,
      preserve: session => { expect(session.runtime?.lastProcessedSeq).toBe(34); preserved++; return true; },
      resume: async (id, environment, validate) => {
        expect(id).toBe('session'); expect(target!.childProcess!.exitCode !== null || target!.childProcess!.signalCode !== null).toBe(true);
        await validate(); await launch(environment); return { type: 'success' };
      },
    }))!;
    const server = await startDaemonControlServer({ writeScopeRuntime: runtime, getChildren: () => target ? [target] : [],
      stopSession: () => ({ stopped: false, reason: 'not-found' }), spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: (id, metadata, encryption) => { expect(id).toBe('session'); target!.happySessionMetadataFromLocalWebhook = metadata; target!.encryption = encryption; },
      onHappySessionRuntime: (_id, report) => { target!.runtime = { thinking: false, hasOpenToolCall: false, ...report }; },
      portRegistry: createPortRegistry({ filePath: join(fixture, 'ports.json'), portMin: 33000, portMax: 33010, isPortBindable: async () => true }),
    });
    baseUrl = `http://127.0.0.1:${server.port}`; secret = server.controlSecret;
    await writeFile(join(configuration.happyHomeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: server.port, controlSecret: secret }));
    async function post(path: string, body: unknown) {
      const response = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      return { status: response.status, body: await response.json() as any };
    }
    async function launch(environment: Record<string, string>) {
      const reports = runtime.prepareReports('session');
      const env = { ...process.env, HAPPY_HOME_DIR: configuration.happyHomeDir, HOME: home, CODEX_HOME: join(fixture, 'codex'),
        CLAUDE_CONFIG_DIR: join(fixture, 'claude'), HAPPY_WRITE_SCOPE_SESSION: '1', APLUS_SESSION_ID: 'session',
        HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify(config), TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json'),
        FIXTURE_PROJECT: project, FIXTURE_PROVIDER: provider, ...environment, ...reports.environment };
      const code = `
        const {initializeScopeReportSigner,takeScopeLaunchBootstrap}=require('./src/daemon/sessionWriteScopeReports.ts');
        const {SessionLaunchControl}=require('./src/sessionDrain/sessionLaunchControl.ts');
        const {RuntimeProducerGate}=require('./src/sessionDrain/runtimeProducerGate.ts');
        const {notifyDaemonSessionStarted,notifyDaemonSessionRuntime}=require('./src/daemon/controlClient.ts');
        const {CodexAppServerClient}=require('./src/codex/codexAppServerClient.ts');
        const {SandboxConfigSchema}=require('./src/persistence.ts');
        (async()=>{
          await initializeScopeReportSigner();
          const control=await SessionLaunchControl.connect(takeScopeLaunchBootstrap());
          if(process.env.HAPPY_SCOPE_REPORT_FD) throw new Error('report descriptor leaked');
          process.chdir(process.env.FIXTURE_PROJECT);
          const report=await notifyDaemonSessionStarted('session',{hostPid:process.pid,flavor:process.env.FIXTURE_PROVIDER},
            {encryptionKey:'ZmFrZQ==',encryptionVariant:'legacy',seq:34,metadataVersion:1,agentStateVersion:1});
          if(report.error) throw new Error(report.error);
          const state=await notifyDaemonSessionRuntime('session',{thinking:false,hasOpenToolCall:false,lastProcessedSeq:34,reportSeq:1});
          if(state.error) throw new Error(state.error);
          let client;
          if(process.env.FIXTURE_PROVIDER==='claude'){
            const {prepareSessionWriteScopeClaude}=require('./src/daemon/sessionWriteScopeClaude.ts');
            const {takeScopeConfirmation}=require('./src/daemon/sessionWriteScopeConfirmation.ts');
            const {query}=require('./src/claude/sdk/query.ts');
            const prepared=await prepareSessionWriteScopeClaude({path:process.cwd(),config:SandboxConfigSchema.parse(JSON.parse(process.env.HAPPY_PROJECT_SANDBOX_CONFIG)),confirmation:takeScopeConfirmation()});
            let child,exit,output;
            const q=query({prompt:{async *[Symbol.asyncIterator](){await new Promise(()=>{})}},options:{cwd:process.cwd(),tools:[],settingSources:[],mcpServers:{},strictMcpConfig:true,sandbox:{enabled:false},spawnClaudeCodeProcess:o=>{
              child=prepared.spawn(o);exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({exited:true,code,signal})));
              output=new Promise(resolve=>child.stdout.once('close',resolve));return child;
            }}});
            await q.supportedCommands();
            client={sandboxEnabled:true,connect:async()=>{},setOutputStorageGate:()=>{},
              freezeInputForShutdown:()=>true,interruptTurn:async()=>{},endInputAndAwaitExit:async()=>{q.close();return await exit},
              waitForOutputDrain:()=>output,cancelOutputDrain:()=>{},finishShutdownObservation:()=>{},disconnect:()=>prepared.close()};
          }else client=new CodexAppServerClient(SandboxConfigSchema.parse(JSON.parse(process.env.HAPPY_PROJECT_SANDBOX_CONFIG)),undefined,undefined,'mandatory',[]);
          client.setOutputStorageGate({wait:async()=>{},onFailure:()=>{throw new Error('native output incomplete')}});
          process.on('SIGTERM',async()=>{await client.endInputAndAwaitExit(5000);await client.disconnect();process.exit(0)});
          await client.connect();
          if(!client.sandboxEnabled || process.env.HAPPY_WRITE_SCOPE_APPLY_TOKEN) throw new Error('provider unprotected or receipt leaked');
          const gate=new RuntimeProducerGate({hasUndeliveredInput:()=>false,canFreezeInbound:()=>true,freezeInbound:()=>true,
            stopLoop:()=>{gate.loopExited();void gate.waitForShutdownDecision().then(decision=>{
              if(decision==='confirmed')setTimeout(async()=>{await client.disconnect();control.close();process.exit(0)},10);
            })}});
          control.bind(client,{tracksShutdownStorage:true,flushForShutdown:async()=>{
            const final=await notifyDaemonSessionRuntime('session',{thinking:false,hasOpenToolCall:false,lastProcessedSeq:34,reportSeq:2});
            return final.error?{stored:false,reason:'unconfirmed-write'}:{stored:true,revision:1};
          },isStorageConfirmationCurrent:()=>true},gate);
          console.log('SCOPE_READY');setInterval(()=>{},1000);
        })().catch(e=>{console.error(e);process.exit(1)});
      `;
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', code], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      children.push(child); reports.attach(child);
      target = { startedBy: 'daemon', pid: child.pid!, directory: project, happySessionId: 'session', childProcess: child,
        agentEnvironment: captureSaycodeAgentEnvironment(env)! };
      await new Promise<void>((resolve, reject) => {
        let output = '', errors = '';
        const timer = setTimeout(() => { cleanup(); reject(new Error('Native scope startup timeout: ' + errors)); }, 20000);
        const onData = (chunk: Buffer) => { output += chunk; if (output.includes('SCOPE_READY')) { cleanup(); resolve(); } };
        const onErrorData = (chunk: Buffer) => { errors += chunk; };
        const onExit = () => { cleanup(); reject(new Error('Native scope exited: ' + errors)); };
        function cleanup() { clearTimeout(timer); child.stdout!.off('data', onData); child.stderr!.off('data', onErrorData); child.off('exit', onExit); }
        child.stdout!.on('data', onData); child.stderr!.on('data', onErrorData); child.once('exit', onExit);
      });
    }
    function approval(request: ScopeRequest) {
      const decision: ScopeDecision = { version: 1, requestId: request.id, digest: request.digest, incarnation: 'host', accountId: 'account',
        machineId: 'machine', sessionId: 'session', action: 'allow' };
      return { decision, signature: sign(null, decisionBytes(decision), keys.privateKey).toString('base64url') };
    }
    try {
      await launch({}); const originalPid = target!.pid;
      expect((await post('/session-runtime', { sessionId: 'session', hostPid: target!.pid, thinking: false, lastProcessedSeq: 999 })).status).toBe(403);
      expect(target!.runtime!.lastProcessedSeq).toBe(34);
      const requested = await post('/session-write-scope', { action: 'request', sessionId: 'session', path: root, description: 'Install fixture tool' });
      expect(requested.status).toBe(200);
      const request = requested.body.result as ScopeRequest;
      expect((await post('/session-write-scope/decide', { ...approval(request), signature: 'unsigned' })).status).toBe(409);
      expect((await post('/session-write-scope/confirm', { token: request.id, sessionId: 'session', digest: request.digest, pid: target!.pid })).status).toBe(403);
      const applied = await post('/session-write-scope/decide', approval(request));
      expect(applied.status).toBe(200); expect(applied.body.result).toMatchObject({ profileApplied: true, grantActive: true, state: 'cleanup-unresolved' });
      expect(target!.pid).not.toBe(originalPid); expect(target!.happySessionId).toBe('session'); expect(preserved).toBe(2);
      expect(target!.agentEnvironment!.HAPPY_PROJECT_SANDBOX_CONFIG).toBe(JSON.stringify(config));
      expect((await post('/session-write-scope/decide', approval(request))).status).toBe(409);
      const revoke = await post('/session-write-scope', { action: 'request', kind: 'revoke', sessionId: 'session', path: root, description: 'Revoke fixture access' });
      const revoked = await post('/session-write-scope/decide', approval(revoke.body.result));
      expect(revoked.body.result).toMatchObject({ profileApplied: true, state: 'cleanup-unresolved' });
      expect(runtime.list('session').find(item => item.id === request.id)?.grantActive).toBe(false);
      expect(preserved).toBe(4);
      expect((await post('/session-write-scope', { action: 'request', sessionId: 'other', path: root, description: 'Other session' })).status).toBe(409);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
      await runtime.close(); await server.stop(); await rm(fixture, { recursive: true, force: true }); await rm(configuration.happyHomeDir, { recursive: true, force: true });
    }
  }, 60000);
});
