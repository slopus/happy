import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './messageMeta';
import { RigMetadataV1Schema } from './rigMetadata';

describe('Rig wire contract', () => {
  it('accepts native Rig message selection codes and provider qualification', () => {
    expect(MessageMetaSchema.parse({
      permissionMode: 'workspace_write',
      model: 'shared-model',
      modelProviderId: 'codex',
      effort: 'high',
    })).toEqual({
      permissionMode: 'workspace_write',
      model: 'shared-model',
      modelProviderId: 'codex',
      effort: 'high',
    });
  });

  it('parses a Rig v1 payload and retains unknown future fields', () => {
    const parsed = RigMetadataV1Schema.parse({
      rigMetadataVersion: 1,
      client: { id: 'rig', name: 'Rig', version: '0.0.30' },
      provider: { id: 'codex', kind: 'codex', name: 'OpenAI Codex' },
      providers: [{ id: 'codex', kind: 'codex', name: 'OpenAI Codex' }],
      model: { providerId: 'codex', id: 'm' },
      models: [{
        id: 'm', code: 'm', name: 'Model', value: 'Model',
        providerId: 'codex', providerKind: 'codex', providerName: 'OpenAI Codex',
        provider: { id: 'codex', kind: 'codex', name: 'OpenAI Codex' },
        serviceTiers: [], thinkingLevels: ['high'], defaultThinkingLevel: 'high',
      }],
      currentModelProviderId: 'codex',
      currentModelCode: 'm',
      permissionMode: 'auto',
      currentOperatingModeCode: 'auto',
      operatingModes: [{ code: 'auto', value: 'Auto', description: 'Sandboxed review.', kind: 'safe-yolo' }],
      reasoning: { current: 'high', levels: ['high'] },
      thoughtLevels: [{ code: 'high', value: 'high' }],
      session: { status: 'running', permissionMode: 'auto', modelLocked: false },
      capabilities: {
        abort: true,
        attachments: { enabled: true, maxBytes: 10, mediaTypes: ['image/*'] },
        files: { browse: true, read: true, search: true, write: true },
        modelSelection: true,
        reasoningSelection: true,
        permissionModeSelection: true,
        resume: false,
        rpcMethods: ['abort', 'bash', 'readFile', 'writeFile', 'ripgrep'],
        shell: true,
        steering: true,
      },
      activity: {
        subagents: { running: 0, queued: 0, total: 0 },
        workflows: { running: 0, total: 0 },
        processes: { running: 0 },
        tasks: { pending: 0, inProgress: 0, completed: 0, total: 0 },
      },
      mcpServers: [], tools: [], skills: [], futureField: true,
    });
    expect((parsed as any).futureField).toBe(true);
    expect(RigMetadataV1Schema.safeParse({
      ...parsed,
      operatingModes: [{ code: 'future', value: 'Future', description: 'Future mode', kind: 'future-kind' }],
    }).success).toBe(true);
  });
});
