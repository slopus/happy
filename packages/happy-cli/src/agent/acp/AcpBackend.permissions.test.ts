import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpBackend } from './AcpBackend';
import type { AgentMessage } from '@/agent/core';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const options = [
  { optionId: 'reject-id', kind: 'reject_once', name: '拒绝' },
  { optionId: 'once-id', kind: 'allow_once', name: '允许本次' },
  { optionId: 'always-read', kind: 'allow_always', name: '允许读取当前目录' },
  { optionId: 'always-exact', kind: 'allow_always', name: '记住此命令' },
] as const;

async function request(decision?: { decision: 'approved' | 'approved_for_session' | 'denied' | 'abort'; optionId?: string }, offered: readonly object[] = options) {
  const dir = await mkdtemp(join(tmpdir(), 'paws-acp-permission-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'outcome.json');
  const script = `
    const fs = require('node:fs'); let promptId;
    const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const message = JSON.parse(line);
      if(message.id==='approval') {
        fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(message.result));
        send({id:promptId,result:{stopReason:'end_turn'}}); return;
      }
      if(message.id===undefined) return;
      if(message.method==='initialize') send({id:message.id,result:{protocolVersion:1,agentCapabilities:{}}});
      else if(message.method==='session/new') send({id:message.id,result:{sessionId:'acp-test'}});
      else if(message.method==='session/prompt') {
        promptId=message.id;
        send({id:'approval',method:'session/request_permission',params:{sessionId:'acp-test',
          toolCall:{toolCallId:'exec-1',kind:'execute',title:'pwd',rawInput:{CommandLine:'pwd'}},options:${JSON.stringify(offered)}}});
      } else send({id:message.id,result:{}});
    });`;
  const messages: AgentMessage[] = [];
  const backend = new AcpBackend({ agentName:'antigravity', cwd:dir, command:process.execPath, args:['-e',script],
    ...(decision ? { permissionHandler: { handleToolCall: async () => decision } } : {}),
  });
  cleanups.push(() => backend.dispose());
  backend.onMessage(message => messages.push(message));
  await backend.startSession();
  await backend.sendPrompt('acp-test','permission transport test');
  return { outcome: JSON.parse(await readFile(output,'utf8')).outcome, messages };
}

describe('ACP permission choices through the real connection', () => {
  it('selects allow_once by protocol kind with localized names and a denial first', async () => {
    expect((await request({decision:'approved'})).outcome).toEqual({outcome:'selected',optionId:'once-id'});
  });
  it('preserves the exact persistent scope selected by the user', async () => {
    expect((await request({decision:'approved_for_session',optionId:'always-exact'})).outcome)
      .toEqual({outcome:'selected',optionId:'always-exact'});
  });
  it('degrades a legacy client-managed persistent decision to a single native approval without widening the grant', async () => {
    expect((await request({decision:'approved_for_session'},options.slice(0,2))).outcome).toEqual({outcome:'selected',optionId:'once-id'});
  });
  it('rejects an option that was not offered', async () => {
    expect((await request({decision:'approved_for_session',optionId:'unknown'})).outcome).toEqual({outcome:'cancelled'});
  });
  it('does not turn a single approval into a persistent grant through a mismatched optionId', async () => {
    expect((await request({decision:'approved',optionId:'always-exact'})).outcome).toEqual({outcome:'cancelled'});
  });
  it('uses the offered reject option for a denial', async () => {
    expect((await request({decision:'denied'})).outcome).toEqual({outcome:'selected',optionId:'reject-id'});
  });
  it('never auto-selects the first denial when no permission handler is installed', async () => {
    expect((await request()).outcome).toEqual({outcome:'selected',optionId:'once-id'});
  });
  it('does not mark a tool completed merely because its permission was granted', async () => {
    expect((await request({decision:'approved'})).messages.filter(message => message.type==='tool-result')).toEqual([]);
  });
});
