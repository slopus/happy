import { describe, it, expect } from 'vitest';
import {
  MessageInfoSchema,
  PartSchema,
  MessageWithPartsSchema,
  ToolStateSchema,
  BlockSchema,
  ResolvedBlockSchema,
  ProtocolEnvelopeSchema,
  PermissionRuleSchema,
  TodoSchema,
  SessionInfoSchema,
  type MessageWithParts,
  type ToolState,
  type ProtocolEnvelope,
} from './protocol';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ids = {
  session: 'ses_01abc' as any,
  userMsg: 'msg_01user' as any,
  assistantMsg: 'msg_02asst' as any,
  part1: 'prt_001' as any,
  part2: 'prt_002' as any,
  part3: 'prt_003' as any,
  part4: 'prt_004' as any,
  part5: 'prt_005' as any,
};

const userMessage = {
  id: ids.userMsg,
  sessionID: ids.session,
  role: 'user' as const,
  time: { created: 1753120000000 },
  agent: 'build',
  model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
};

const assistantMessage = {
  id: ids.assistantMsg,
  sessionID: ids.session,
  role: 'assistant' as const,
  time: { created: 1753120001000, completed: 1753120004000 },
  parentID: ids.userMsg,
  modelID: 'claude-sonnet-4-6',
  providerID: 'anthropic',
  agent: 'build',
  path: { cwd: '/home/user/app', root: '/home/user/app' },
  cost: 0.0087,
  tokens: { input: 4200, output: 340, reasoning: 0, cache: { read: 3800, write: 400 } },
  finish: 'tool-calls',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('protocol v3', () => {
  describe('MessageInfo', () => {
    it('parses user message', () => {
      const result = MessageInfoSchema.parse(userMessage);
      expect(result.role).toBe('user');
    });

    it('parses user message with typed meta overrides', () => {
      const result = MessageInfoSchema.parse({
        ...userMessage,
        meta: {
          permissionMode: 'plan',
          model: 'claude-sonnet-4-6',
          appendSystemPrompt: 'Keep the summary short.',
        },
      });
      expect(result.role).toBe('user');
      if (result.role === 'user') {
        expect(result.meta?.permissionMode).toBe('plan');
        expect(result.meta?.appendSystemPrompt).toBe('Keep the summary short.');
      }
    });

    it('parses assistant message', () => {
      const result = MessageInfoSchema.parse(assistantMessage);
      expect(result.role).toBe('assistant');
      if (result.role === 'assistant') {
        expect(result.cost).toBe(0.0087);
      }
    });

    it('rejects unknown role', () => {
      expect(() => MessageInfoSchema.parse({ ...userMessage, role: 'system' })).toThrow();
    });
  });

  describe('Parts', () => {
    it('parses text part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.userMsg,
        type: 'text', text: 'hello world',
      };
      expect(PartSchema.parse(part).type).toBe('text');
    });

    it('parses reasoning part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'reasoning', text: 'thinking...', time: { start: 1000 },
      };
      expect(PartSchema.parse(part).type).toBe('reasoning');
    });

    it('parses step-start and step-finish', () => {
      const start = {
        id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'step-start', snapshot: 'abc123',
      };
      const finish = {
        id: ids.part2, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'step-finish', reason: 'stop', cost: 0.01,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 80, write: 20 } },
      };
      expect(PartSchema.parse(start).type).toBe('step-start');
      expect(PartSchema.parse(finish).type).toBe('step-finish');
    });

    it('parses file part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.userMsg,
        type: 'file', mime: 'image/png', filename: 'shot.png',
        url: 'data:image/png;base64,abc',
      };
      expect(PartSchema.parse(part).type).toBe('file');
    });

    it('parses compaction part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'compaction', auto: true,
      };
      expect(PartSchema.parse(part).type).toBe('compaction');
    });

    it('parses subtask part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'subtask', prompt: 'Explore keyboard events',
        description: 'Subagent: explore keyboard events',
        agent: 'claude',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        command: '/explore',
      };
      const parsed = PartSchema.parse(part);
      expect(parsed.type).toBe('subtask');
      if (parsed.type === 'subtask') {
        expect(parsed.prompt).toBe('Explore keyboard events');
        expect(parsed.agent).toBe('claude');
      }
    });

    it('parses agent part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'agent', name: 'explore-agent',
      };
      const parsed = PartSchema.parse(part);
      expect(parsed.type).toBe('agent');
      if (parsed.type === 'agent') {
        expect(parsed.name).toBe('explore-agent');
      }
    });

    it('parses snapshot part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'snapshot', snapshot: 'abc123def456',
      };
      const parsed = PartSchema.parse(part);
      expect(parsed.type).toBe('snapshot');
      if (parsed.type === 'snapshot') {
        expect(parsed.snapshot).toBe('abc123def456');
      }
    });

    it('parses patch part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'patch', hash: 'sha256:abc', files: ['src/index.ts', 'src/utils.ts'],
      };
      const parsed = PartSchema.parse(part);
      expect(parsed.type).toBe('patch');
      if (parsed.type === 'patch') {
        expect(parsed.files).toHaveLength(2);
      }
    });

    it('parses retry part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'retry', attempt: 2,
        error: { name: 'RateLimitError', data: { retryAfter: 5 } },
        time: { created: 1753120000000 },
      };
      const parsed = PartSchema.parse(part);
      expect(parsed.type).toBe('retry');
      if (parsed.type === 'retry') {
        expect(parsed.attempt).toBe(2);
        expect(parsed.error.name).toBe('RateLimitError');
      }
    });

    it('parses decision part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.userMsg,
        type: 'decision',
        targetMessageID: ids.assistantMsg,
        targetCallID: 'call_abc',
        permissionID: 'per_001',
        decision: 'once',
        decidedAt: 1753120003000,
      };
      const parsed = PartSchema.parse(part);
      expect(parsed.type).toBe('decision');
      if (parsed.type === 'decision') {
        expect(parsed.decision).toBe('once');
        expect(parsed.permissionID).toBe('per_001');
      }
    });

    it('parses decision part with always + allowTools', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.userMsg,
        type: 'decision',
        targetMessageID: ids.assistantMsg,
        targetCallID: 'call_abc',
        permissionID: 'per_002',
        decision: 'always',
        allowTools: ['Write', 'Edit'],
        decidedAt: 1753120003000,
      };
      const parsed = PartSchema.parse(part);
      if (parsed.type === 'decision') {
        expect(parsed.decision).toBe('always');
        expect(parsed.allowTools).toEqual(['Write', 'Edit']);
      }
    });

    it('parses answer part', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.userMsg,
        type: 'answer',
        targetMessageID: ids.assistantMsg,
        targetCallID: 'call_abc',
        questionID: 'q_001',
        answers: [['Vitest']],
        decidedAt: 1753120003000,
      };
      const parsed = PartSchema.parse(part);
      expect(parsed.type).toBe('answer');
      if (parsed.type === 'answer') {
        expect(parsed.answers).toEqual([['Vitest']]);
      }
    });

    it('rejects part with unknown type', () => {
      const part = {
        id: ids.part1, sessionID: ids.session, messageID: ids.userMsg,
        type: 'unknown-thing', text: 'foo',
      };
      expect(() => PartSchema.parse(part)).toThrow();
    });
  });

  describe('ToolState', () => {
    it('parses pending', () => {
      const state: ToolState = { status: 'pending', input: { path: 'foo.txt' }, raw: '{"path":"foo.txt"}' };
      expect(ToolStateSchema.parse(state).status).toBe('pending');
    });

    it('parses running', () => {
      const state: ToolState = {
        status: 'running', input: { path: 'foo.txt' },
        title: 'writeFile', time: { start: 1000 },
      };
      expect(ToolStateSchema.parse(state).status).toBe('running');
    });

    it('parses blocked with permission', () => {
      const state = {
        status: 'blocked',
        input: { path: 'foo.txt' },
        time: { start: 1000 },
        block: {
          type: 'permission', id: 'per_001', permission: 'edit',
          patterns: ['foo.txt'], always: ['*'],
          metadata: { filepath: 'foo.txt' },
        },
      };
      const parsed = ToolStateSchema.parse(state);
      expect(parsed.status).toBe('blocked');
      if (parsed.status === 'blocked') {
        expect(parsed.block.type).toBe('permission');
      }
    });

    it('parses blocked with question', () => {
      const state = {
        status: 'blocked',
        input: {},
        time: { start: 1000 },
        block: {
          type: 'question', id: 'q_001',
          questions: [{
            question: 'Which DB?', header: 'DB choice',
            options: [
              { label: 'PostgreSQL', description: 'Reliable' },
              { label: 'SQLite', description: 'Simple' },
            ],
          }],
        },
      };
      const parsed = ToolStateSchema.parse(state);
      expect(parsed.status).toBe('blocked');
      if (parsed.status === 'blocked') {
        expect(parsed.block.type).toBe('question');
      }
    });

    it('parses completed with resolved permission block', () => {
      const state = {
        status: 'completed',
        input: { path: 'foo.txt', content: 'hello' },
        output: 'Created foo.txt',
        title: 'writeFile foo.txt',
        metadata: {},
        time: { start: 1000, end: 2000 },
        block: {
          type: 'permission', id: 'per_001', permission: 'edit',
          patterns: ['foo.txt'], always: ['*'],
          metadata: { filepath: 'foo.txt' },
          decision: 'once', decidedAt: 1500,
        },
      };
      const parsed = ToolStateSchema.parse(state);
      expect(parsed.status).toBe('completed');
      if (parsed.status === 'completed' && parsed.block) {
        expect(parsed.block.type).toBe('permission');
        if (parsed.block.type === 'permission') {
          expect(parsed.block.decision).toBe('once');
        }
      }
    });

    it('parses error with resolved question block', () => {
      const state = {
        status: 'error',
        input: {},
        error: 'User dismissed',
        time: { start: 1000, end: 1500 },
        block: {
          type: 'question', id: 'q_001',
          questions: [{ question: 'Which DB?', header: 'DB', options: [] }],
          answers: [], decidedAt: 1400,
        },
      };
      const parsed = ToolStateSchema.parse(state);
      expect(parsed.status).toBe('error');
    });
  });

  describe('ToolPart', () => {
    it('parses full tool part with blocked→completed lifecycle', () => {
      const part = {
        id: ids.part3, sessionID: ids.session, messageID: ids.assistantMsg,
        type: 'tool', callID: 'call_abc', tool: 'writeFile',
        state: {
          status: 'completed',
          input: { path: 'hello.txt', content: 'hello world\n' },
          output: 'Created hello.txt (12 bytes)',
          title: 'writeFile hello.txt',
          metadata: {},
          time: { start: 1753120001500, end: 1753120003800 },
          block: {
            type: 'permission', id: 'per_001', permission: 'edit',
            patterns: ['hello.txt'], always: ['*'],
            metadata: { filepath: 'hello.txt' },
            decision: 'once', decidedAt: 1753120002500,
          },
        },
      };
      const parsed = PartSchema.parse(part);
      expect(parsed.type).toBe('tool');
    });
  });

  describe('MessageWithParts', () => {
    it('parses full exchange', () => {
      const msg: MessageWithParts = {
        info: assistantMessage,
        parts: [
          {
            id: ids.part1, sessionID: ids.session, messageID: ids.assistantMsg,
            type: 'step-start', snapshot: 'a1b2c3',
          },
          {
            id: ids.part2, sessionID: ids.session, messageID: ids.assistantMsg,
            type: 'reasoning', text: 'I will create the file...',
            time: { start: 1000, end: 1200 },
          },
          {
            id: ids.part3, sessionID: ids.session, messageID: ids.assistantMsg,
            type: 'tool', callID: 'call_1', tool: 'writeFile',
            state: {
              status: 'completed',
              input: { path: 'hello.txt' },
              output: 'Created hello.txt',
              title: 'writeFile hello.txt',
              metadata: {},
              time: { start: 1200, end: 1800 },
            },
          },
          {
            id: ids.part4, sessionID: ids.session, messageID: ids.assistantMsg,
            type: 'step-finish', reason: 'tool-calls', cost: 0.008,
            tokens: { input: 4000, output: 300, reasoning: 0, cache: { read: 3500, write: 500 } },
          },
        ],
      };
      const parsed = MessageWithPartsSchema.parse(msg);
      expect(parsed.parts).toHaveLength(4);
    });
  });

  describe('ProtocolEnvelope', () => {
    it('wraps message with version marker', () => {
      const envelope: ProtocolEnvelope = {
        v: 3,
        message: {
          info: userMessage,
          parts: [{
            id: ids.part1, sessionID: ids.session, messageID: ids.userMsg,
            type: 'text', text: 'hello',
          }],
        },
      };
      const parsed = ProtocolEnvelopeSchema.parse(envelope);
      expect(parsed.v).toBe(3);
      expect('info' in parsed.message && parsed.message.info.role).toBe('user');
    });

    it('rejects wrong version', () => {
      expect(() => ProtocolEnvelopeSchema.parse({
        v: 2,
        message: { info: userMessage, parts: [] },
      })).toThrow();
    });
  });

  describe('PermissionRule', () => {
    it('parses valid rule', () => {
      const rule = { permission: 'edit', pattern: '*.ts', action: 'ask' };
      expect(PermissionRuleSchema.parse(rule).action).toBe('ask');
    });
  });

  describe('Todo', () => {
    it('parses valid todo', () => {
      const todo = { content: 'Add tests', status: 'pending', priority: 'high' };
      expect(TodoSchema.parse(todo).status).toBe('pending');
    });
  });

  describe('SessionInfo', () => {
    it('parses session with parent and permissions', () => {
      const session = {
        id: ids.session,
        projectID: 'proj_001',
        directory: '/home/user/app',
        parentID: 'ses_parent' as any,
        title: 'Fix bugs (@explore)',
        time: { created: 1000, updated: 2000 },
        permission: [
          { permission: 'edit', pattern: '*', action: 'deny' },
        ],
      };
      const parsed = SessionInfoSchema.parse(session);
      expect(parsed.parentID).toBe('ses_parent');
      expect(parsed.permission).toHaveLength(1);
    });
  });
});
