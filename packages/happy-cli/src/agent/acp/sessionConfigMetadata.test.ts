import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  extractConfigOptionsFromPayload,
  mergeAcpSessionConfigIntoMetadata,
} from './sessionConfigMetadata';

function createBaseMetadata(): Metadata {
  return {
    path: '/repo',
    host: 'host',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/repo/.happy/lib',
    happyToolsDir: '/repo/.happy/tools',
  };
}

function selectOption(input: {
  id: string;
  name: string;
  category: string;
  currentValue: string;
  options: Array<{ value: string; name: string; description?: string | null }>;
}): SessionConfigOption {
  return {
    type: 'select',
    id: input.id,
    name: input.name,
    category: input.category,
    currentValue: input.currentValue,
    options: input.options,
  };
}

describe('sessionConfigMetadata', () => {
  it('maps supported ACP config option categories into metadata', () => {
    const metadata = createBaseMetadata();
    const configOptions: SessionConfigOption[] = [
      selectOption({
        id: 'session_mode',
        name: 'Mode',
        category: 'mode',
        currentValue: 'code',
        options: [
          { value: 'ask', name: 'Ask', description: 'Q&A only' },
          { value: 'code', name: 'Code', description: 'Write and edit files' },
        ],
      }),
      selectOption({
        id: 'session_model',
        name: 'Model',
        category: 'model',
        currentValue: 'claude-sonnet',
        options: [
          { value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced model' },
          { value: 'claude-opus', name: 'Claude Opus', description: 'High reasoning quality' },
        ],
      }),
      selectOption({
        id: 'reasoning_depth',
        name: 'Thought Level',
        category: 'thought_level',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      }),
      selectOption({
        id: 'custom',
        name: 'Custom',
        category: '_custom',
        currentValue: 'x',
        options: [{ value: 'x', name: 'X' }],
      }),
    ];

    const next = mergeAcpSessionConfigIntoMetadata(metadata, { configOptions });

    expect(next.operatingModes).toEqual([
      { code: 'ask', value: 'Ask', description: 'Q&A only' },
      { code: 'code', value: 'Code', description: 'Write and edit files' },
    ]);
    expect(next.currentOperatingModeCode).toBe('code');

    expect(next.models).toEqual([
      { code: 'claude-sonnet', value: 'Claude Sonnet', description: 'Balanced model' },
      { code: 'claude-opus', value: 'Claude Opus', description: 'High reasoning quality' },
    ]);
    expect(next.currentModelCode).toBe('claude-sonnet');

    expect(next.thoughtLevels).toEqual([
      { code: 'low', value: 'Low' },
      { code: 'medium', value: 'Medium' },
      { code: 'high', value: 'High' },
    ]);
    expect(next.currentThoughtLevelCode).toBe('medium');
  });

  it('falls back to legacy modes/models when configOptions are not present', () => {
    const metadata = createBaseMetadata();

    const next = mergeAcpSessionConfigIntoMetadata(metadata, {
      modes: {
        availableModes: [
          { id: 'ask', name: 'Ask', description: 'Ask mode' },
          { id: 'code', name: 'Code', description: 'Code mode' },
        ],
        currentModeId: 'ask',
      },
      models: {
        availableModels: [
          { modelId: 'm1', name: 'Model 1', description: 'Fast' },
          { modelId: 'm2', name: 'Model 2', description: 'Reasoning' },
        ],
        currentModelId: 'm2',
      },
    });

    expect(next.operatingModes).toEqual([
      { code: 'ask', value: 'Ask', description: 'Ask mode' },
      { code: 'code', value: 'Code', description: 'Code mode' },
    ]);
    expect(next.currentOperatingModeCode).toBe('ask');
    expect(next.models).toEqual([
      { code: 'm1', value: 'Model 1', description: 'Fast' },
      { code: 'm2', value: 'Model 2', description: 'Reasoning' },
    ]);
    expect(next.currentModelCode).toBe('m2');
  });

  it('prefers configOptions mode/model selectors over legacy mode/model state', () => {
    const metadata = createBaseMetadata();

    const next = mergeAcpSessionConfigIntoMetadata(metadata, {
      configOptions: [
        selectOption({
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'code',
          options: [{ value: 'code', name: 'Code' }],
        }),
        selectOption({
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'new-model',
          options: [{ value: 'new-model', name: 'New Model' }],
        }),
      ],
      modes: {
        availableModes: [{ id: 'ask', name: 'Ask' }],
        currentModeId: 'ask',
      },
      models: {
        availableModels: [{ modelId: 'legacy-model', name: 'Legacy Model' }],
        currentModelId: 'legacy-model',
      },
    });

    expect(next.operatingModes).toEqual([{ code: 'code', value: 'Code' }]);
    expect(next.currentOperatingModeCode).toBe('code');
    expect(next.models).toEqual([{ code: 'new-model', value: 'New Model' }]);
    expect(next.currentModelCode).toBe('new-model');
  });

  it('extracts configOptions payload from either array or wrapped object', () => {
    const option = selectOption({
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'm',
      options: [{ value: 'm', name: 'Model' }],
    });

    expect(extractConfigOptionsFromPayload([option])).toEqual([option]);
    expect(extractConfigOptionsFromPayload({ configOptions: [option] })).toEqual([option]);
    expect(extractConfigOptionsFromPayload({})).toBeNull();
  });
});
