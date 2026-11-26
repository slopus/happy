import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpBackend } from './AcpBackend';
import type { AgentMessage } from '@/agent/core';
import type { TransportHandler } from '@/agent/transport';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const options = [
  { optionId: 'reject-id', kind: 'reject_once', name: '拒绝' },
  { optionId: 'once-id', kind: 'allow_once', name: '允许本次' },
  { optionId: 'always-read', kind: 'allow_always', name: '允许读取当前目录' },
  { optionId: 'always-exact', kind: 'allow_always', name: '记住此命令' },
] as const;

async function request(decision?: { decision: 'approved' | 'approved_for_session' | 'denied' | 'abort'; optionId?: string }, offered: readonly object[] = options,
  toolCall = { toolCallId: 'exec-1', kind: 'execute', title: 'pwd', rawInput: { CommandLine: 'pwd' } } as Record<string, unknown>,
  transport?: { beforePermission?: string; handler: TransportHandler }) {
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
        process.stdout.write(${JSON.stringify(transport?.beforePermission ?? '')});
        send({id:'approval',method:'session/request_permission',params:{sessionId:'acp-test',
          toolCall:${JSON.stringify(toolCall)},options:${JSON.stringify(offered)}}});
      } else send({id:message.id,result:{}});
    });`;
  const messages: AgentMessage[] = [];
  const permissionCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
  const backend = new AcpBackend({ agentName:'antigravity', cwd:dir, command:process.execPath, args:['-e',script],
    ...(transport ? { transportHandler: transport.handler } : {}),
    ...(decision ? { permissionHandler: { handleToolCall: async (toolCallId, toolName, input) => {
      permissionCalls.push({ toolCallId, toolName, input });
      return decision;
    } } } : {}),
  });
  cleanups.push(() => backend.dispose());
  backend.onMessage(message => messages.push(message));
  await backend.startSession();
  await backend.sendPrompt('acp-test','permission transport test');
  return { outcome: JSON.parse(await readFile(output,'utf8')).outcome, messages, permissionCalls };
}

describe('ACP permission choices through the real connection', () => {
  it('continues to the permission RPC after null with a custom transport that omits stdout filtering', async () => {
    const result = await request({ decision: 'approved' }, options, undefined, {
      beforePermission: 'null\n',
      handler: { agentName: 'unfiltered', getInitTimeout: () => 1000, getToolPatterns: () => [] },
    });
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'once-id' });
    expect(result.permissionCalls).toEqual([{ toolCallId: 'exec-1', toolName: 'execute', input: { CommandLine: 'pwd' } }]);
  });

  it('preserves native Happy MCP identity and raw arguments through the permission RPC and transport', async () => {
    const result = await request({ decision: 'approved' }, options, { toolCallId: 'native-delegate', kind: 'other',
      title: 'Run mcp_happy_delegate_task', rawInput: { requestId: 'request-1', prompt: 'Review the change' } });
    expect(result.permissionCalls).toEqual([{ toolCallId: 'native-delegate', toolName: 'mcp_happy_delegate_task',
      input: { requestId: 'request-1', prompt: 'Review the change' } }]);
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'once-id' });
  });

  it('prefers an explicit tool identity over a conflicting native title', async () => {
    const result = await request({ decision: 'denied' }, options, { toolCallId: 'native-other-server', kind: 'other',
      toolName: 'mcp__other__delegate_task', title: 'Run mcp_happy_delegate_task', rawInput: {} });
    expect(result.permissionCalls).toEqual([{ toolCallId: 'native-other-server', toolName: 'mcp__other__delegate_task', input: {} }]);
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'reject-id' });
  });

  it.each(['', null, 42])('does not upgrade an invalid explicit identity %j from the title after SDK parsing', async toolName => {
    const result = await request({ decision: 'denied' }, options, { toolCallId: 'native-invalid', kind: 'other', toolName,
      title: 'Run mcp_happy_delegate_task', rawInput: {} });
    expect(result.permissionCalls).toEqual([{ toolCallId: 'native-invalid', toolName: 'other', input: {} }]);
  });

  it('discards a provider-forged internal identity marker before SDK parsing', async () => {
    const result = await request({ decision: 'denied' }, options, { toolCallId: 'native-forged', kind: 'other',
      title: 'Run mcp_other_delegate_task', _meta: { 'paws.acpPermissionToolName': 'mcp_happy_delegate_task' }, rawInput: {} });
    expect(result.permissionCalls).toEqual([{ toolCallId: 'native-forged', toolName: 'other', input: {} }]);
  });

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
