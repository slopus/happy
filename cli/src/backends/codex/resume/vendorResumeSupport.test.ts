import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { supportsCodexVendorResume } from './vendorResumeSupport';

describe('supportsCodexVendorResume', () => {
  const prev = process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME;
  const prevAcp = process.env.HAPPY_EXPERIMENTAL_CODEX_ACP;

  beforeEach(() => {
    delete process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME;
    delete process.env.HAPPY_EXPERIMENTAL_CODEX_ACP;
  });

  afterEach(() => {
    if (typeof prev === 'string') process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME = prev;
    else delete process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME;
    if (typeof prevAcp === 'string') process.env.HAPPY_EXPERIMENTAL_CODEX_ACP = prevAcp;
    else delete process.env.HAPPY_EXPERIMENTAL_CODEX_ACP;
  });

  it('rejects by default', () => {
    expect(supportsCodexVendorResume({})).toBe(false);
  });

  it('allows when explicitly enabled for this spawn', () => {
    expect(supportsCodexVendorResume({ experimentalCodexResume: true })).toBe(true);
  });

  it('allows when explicitly enabled via ACP for this spawn', () => {
    expect(supportsCodexVendorResume({ experimentalCodexAcp: true })).toBe(true);
  });

  it('allows when HAPPY_EXPERIMENTAL_CODEX_RESUME is set', () => {
    process.env.HAPPY_EXPERIMENTAL_CODEX_RESUME = '1';
    expect(supportsCodexVendorResume({})).toBe(true);
  });

  it('allows when HAPPY_EXPERIMENTAL_CODEX_ACP is set', () => {
    process.env.HAPPY_EXPERIMENTAL_CODEX_ACP = '1';
    expect(supportsCodexVendorResume({})).toBe(true);
  });
});

