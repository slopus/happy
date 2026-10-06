import { execFileSync } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectAgentModelCatalogs,
  parseCodexModelCatalog,
  sameAgentModelCatalogs,
} from './agentModelCatalog';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

const mockedExecFileSync = vi.mocked(execFileSync);

/** Shaped after `codex debug models` 0.157.1, trimmed to the read fields. */
const CODEX_CATALOG = JSON.stringify({
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      description: 'Previous workhorse.',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }],
      visibility: 'list',
      priority: 5,
    },
    {
      slug: 'gpt-reserve',
      display_name: 'GPT-Reserve',
      visibility: 'hide',
      priority: 4,
      supported_reasoning_levels: [{ effort: 'low' }],
    },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      description: 'Frontier intelligence.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }],
      visibility: 'list',
      priority: 2,
    },
  ],
});

describe('Codex model catalog', () => {
  it('keeps only the models Codex lists, in the order Codex ranks them', () => {
    const models = parseCodexModelCatalog(CODEX_CATALOG);

    expect(models?.map((model) => model.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
  });

  it('carries each model its own efforts and default', () => {
    const models = parseCodexModelCatalog(CODEX_CATALOG);

    expect(models?.[1]).toEqual({
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6-Sol',
      description: 'Previous workhorse.',
      efforts: ['low', 'medium', 'ultra'],
      defaultEffort: 'low',
    });
  });

  // A model with no priority is a model Codex did not rank. Sorting it to the
  // front would put an unranked entry above the one Codex leads with.
  it('sorts an unranked model after every ranked one', () => {
    const models = parseCodexModelCatalog(JSON.stringify({
      models: [
        { slug: 'unranked', visibility: 'list' },
        { slug: 'ranked', visibility: 'list', priority: 9 },
      ],
    }));

    expect(models?.map((model) => model.id)).toEqual(['ranked', 'unranked']);
  });

  it('falls back to the slug when Codex gives no display name', () => {
    const models = parseCodexModelCatalog(JSON.stringify({
      models: [{ slug: 'gpt-nameless', visibility: 'list' }],
    }));

    expect(models?.[0]).toMatchObject({ id: 'gpt-nameless', name: 'gpt-nameless', efforts: [] });
  });

  // Null and empty are different answers: one is "could not be read", the other
  // is "read, and it offers nothing". Only the first may be retried.
  it('tells an unreadable answer apart from an empty one', () => {
    expect(parseCodexModelCatalog('not json')).toBeNull();
    expect(parseCodexModelCatalog('{}')).toBeNull();
    expect(parseCodexModelCatalog('{"models":[]}')).toEqual([]);
  });
});

describe('detecting catalogs across agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks only the agents this machine actually has', () => {
    mockedExecFileSync.mockReturnValue(CODEX_CATALOG as never);

    detectAgentModelCatalogs({ codex: false, claude: true });

    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('reports the catalog of an agent that answers', () => {
    mockedExecFileSync.mockReturnValue(CODEX_CATALOG as never);

    const catalogs = detectAgentModelCatalogs({ codex: true });

    expect(mockedExecFileSync).toHaveBeenCalledWith('codex', ['debug', 'models'], expect.anything());
    expect(catalogs.codex.models.map((model) => model.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
    expect(catalogs.codex.detectedAt).toBeGreaterThan(0);
  });

  // An agent too old for the subcommand, or killed by the OS, must leave no
  // entry at all: an empty one would read as "this agent has no models" and
  // the app would offer an empty picker instead of its own list.
  it('leaves out an agent that cannot be asked', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('unknown subcommand'); });

    expect(detectAgentModelCatalogs({ codex: true })).toEqual({});
  });

  it('leaves out an agent that answers with nothing', () => {
    mockedExecFileSync.mockReturnValue('{"models":[]}' as never);

    expect(detectAgentModelCatalogs({ codex: true })).toEqual({});
  });

  // The timestamp changes on every detection; republishing metadata because of
  // it alone would churn the machine record for no new information.
  it('compares catalogs by their models, not by when they were read', () => {
    const models = [{ id: 'a', name: 'A', description: null, efforts: [], defaultEffort: null }];

    expect(sameAgentModelCatalogs(
      { codex: { models, detectedAt: 1 } },
      { codex: { models, detectedAt: 2 } },
    )).toBe(true);
    expect(sameAgentModelCatalogs(
      { codex: { models, detectedAt: 1 } },
      { codex: { models: [], detectedAt: 1 } },
    )).toBe(false);
    expect(sameAgentModelCatalogs(undefined, { codex: { models, detectedAt: 1 } })).toBe(false);
  });
});
