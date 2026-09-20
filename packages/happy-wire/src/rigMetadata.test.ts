import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './messageMeta';
import { RigBotSchema, RigMetadataV1Schema } from './rigMetadata';

describe('Rig wire contract', () => {
  it('validates the bounded additive bot identity', () => {
    const bot = { id: 'bot-1', name: 'Assistant', username: 'assistant', workspaceId: 'workspace-1', orderKey: '1' };
    expect(RigBotSchema.parse(bot)).toEqual(bot);
    expect(RigBotSchema.safeParse({ ...bot, id: '' }).success).toBe(false);
    expect(RigBotSchema.safeParse({ ...bot, username: 'a'.repeat(65) }).success).toBe(false);
    expect(RigBotSchema.parse({ ...bot, future: true })).toHaveProperty('future', true);
  });

  it('accepts native Rig message selection codes and provider qualification', () => {
    expect(MessageMetaSchema.parse({
      expectsAcceptance: true,
      queuedWhileBusy: true,
      permissionMode: 'workspace_write',
      model: 'shared-model',
      modelProviderId: 'codex',
      effort: 'high',
    })).toEqual({
      expectsAcceptance: true,
      queuedWhileBusy: true,
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

  it('parses composer drafts and timestamped clears without obsolete selection fields', () => {
    const lastMode = {
      effort: 'high', modelId: 'm', permissionMode: 'auto', providerId: 'codex', serviceTier: null,
    };
    const payload = {
      capabilities: {
        abort: true,
        attachments: { enabled: true, maxBytes: 10485760, mediaTypes: ['image/*'] },
        files: { browse: false, read: false, search: false, write: false },
        modelSelection: true,
        permissionModeSelection: true,
        reasoningSelection: true,
        resume: false,
        rpcMethods: ['abort'],
        shell: false,
        steering: true,
      },
      client: { id: 'rig', name: 'Happy Agent', version: '0.0.40' },
      draft: { ...lastMode, text: 'Finish this on the phone' },
      draftUpdatedAt: 1_758_262_000_000,
      lastMode,
      models: [],
      operatingModes: [],
      providers: [],
      rigMetadataVersion: 1,
      session: { modelLocked: false, status: 'idle' },
      tools: [],
    };
    const parsed = RigMetadataV1Schema.parse(payload);
    expect(parsed.draft).toMatchObject({ text: 'Finish this on the phone', serviceTier: null });
    expect(parsed.lastMode).toMatchObject(lastMode);

    // A cleared draft keeps its timestamp.
    const cleared = RigMetadataV1Schema.parse({
      ...payload, draft: null, draftUpdatedAt: 1_758_262_000_001, lastMode: null,
    });
    expect(cleared.draft).toBeNull();
    expect(cleared.draftUpdatedAt).toBe(1_758_262_000_001);

  });
});
