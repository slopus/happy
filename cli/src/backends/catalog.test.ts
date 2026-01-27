import { describe, expect, it } from 'vitest';

import { AGENT_IDS, DEFAULT_AGENT_ID } from '@happy/agents';

import { AGENTS } from './catalog';
import { DEFAULT_CATALOG_AGENT_ID } from './types';

describe('AGENTS', () => {
  it('has unique cliSubcommand values', () => {
    const values = Object.values(AGENTS).map((entry) => entry.cliSubcommand);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keys match entry ids', () => {
    for (const [key, entry] of Object.entries(AGENTS)) {
      expect(key).toBe(entry.id);
    }
  });

  it('declares vendor resume support for every agent', () => {
    for (const entry of Object.values(AGENTS)) {
      expect(entry.vendorResumeSupport).toBeTruthy();
    }
  });

  it('matches shared agent ids', () => {
    const keys = Object.keys(AGENTS).slice().sort();
    const shared = [...AGENT_IDS].slice().sort();
    expect(keys).toEqual(shared);
  });

  it('uses the shared default agent id', () => {
    expect(DEFAULT_CATALOG_AGENT_ID).toBe(DEFAULT_AGENT_ID);
  });
});
