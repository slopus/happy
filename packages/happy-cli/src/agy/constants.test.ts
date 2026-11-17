import { execSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AGY_CLAUDE_OPUS_5_5_MODEL,
  AGY_GEMINI_3_8_FLASH_MODEL,
  AGY_GEMINI_4_ARGON_MODEL,
  AGY_GEMINI_4_CARBON_MODEL,
  AGY_GEMINI_4_HYDROGEN_MODEL,
  AGY_GEMINI_4_NEON_MODEL,
  AGY_ORCHESTRATOR_CARBON_MODEL,
  AGY_ORCHESTRATOR_NEON_MODEL,
  DEFAULT_AGY_EFFORT,
  DEFAULT_AGY_MODEL,
  findAgyBin,
  parseAgyModelsOutput,
  resolveAgyBin,
  resolveAgyModelName,
} from './constants';

vi.mock('node:child_process', () => ({ execSync: vi.fn(), execFileSync: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);

describe('resolveAgyBin', () => {
  const orig = process.env.HAPPY_AGY_PATH;

  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.alloc(0));
  });

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.HAPPY_AGY_PATH;
    } else {
      process.env.HAPPY_AGY_PATH = orig;
    }
  });

  it('uses HAPPY_AGY_PATH when it points at an existing file', () => {
    // node's own binary is guaranteed to exist on every platform
    process.env.HAPPY_AGY_PATH = process.execPath;
    expect(findAgyBin()).toBe(process.execPath);
    expect(resolveAgyBin()).toBe(process.execPath);
  });

  it('ignores HAPPY_AGY_PATH when the target does not exist', () => {
    process.env.HAPPY_AGY_PATH = '/nonexistent/path/to/agy-should-not-resolve';
    expect(resolveAgyBin()).not.toBe('/nonexistent/path/to/agy-should-not-resolve');
  });

  it('hides the PATH probe so detached Windows daemons do not flash a console', () => {
    delete process.env.HAPPY_AGY_PATH;

    findAgyBin();

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringMatching(/^(where|command -v) agy$/),
      { stdio: 'ignore', windowsHide: true },
    );
  });
});

describe('resolveAgyModelName', () => {
  it('defaults to Gemini 4 Hydrogen and maps multi-effort models to agy display names', () => {
    expect(DEFAULT_AGY_MODEL).toBe(AGY_GEMINI_4_HYDROGEN_MODEL);
    expect(resolveAgyModelName(DEFAULT_AGY_MODEL, DEFAULT_AGY_EFFORT))
      .toBe('Gemini 4 Hydrogen (Medium)');
    expect(resolveAgyModelName(AGY_GEMINI_4_NEON_MODEL, 'xhigh'))
      .toBe('Gemini 4 Neon (XHigh)');
    expect(resolveAgyModelName(AGY_GEMINI_4_CARBON_MODEL, 'high'))
      .toBe('Gemini 4 Carbon (High)');
    expect(resolveAgyModelName(AGY_GEMINI_4_ARGON_MODEL, 'low'))
      .toBe('Gemini 4 Argon (Low)');
    expect(resolveAgyModelName(AGY_GEMINI_4_HYDROGEN_MODEL, 'xhigh'))
      .toBe('Gemini 4 Hydrogen (XHigh)');
    expect(resolveAgyModelName(AGY_GEMINI_3_8_FLASH_MODEL, 'high'))
      .toBe('Gemini 3.8 Flash (High)');
    expect(resolveAgyModelName(AGY_CLAUDE_OPUS_5_5_MODEL, 'high'))
      .toBe('Claude Opus 5.5 (High)');
  });

  it('resolves CLI shorthand aliases', () => {
    expect(resolveAgyModelName('neon', 'xhigh')).toBe('Gemini 4 Neon (XHigh)');
    expect(resolveAgyModelName('carbon', 'high')).toBe('Gemini 4 Carbon (High)');
    expect(resolveAgyModelName('argon', 'medium')).toBe('Gemini 4 Argon (Medium)');
    expect(resolveAgyModelName('hydrogen', 'xhigh')).toBe('Gemini 4 Hydrogen (XHigh)');
    expect(resolveAgyModelName('orchestrator', 'high')).toBe(AGY_ORCHESTRATOR_CARBON_MODEL);
    expect(resolveAgyModelName('orchestrator-neon', 'high')).toBe(AGY_ORCHESTRATOR_NEON_MODEL);
  });

  it('uses Medium for an absent or unsupported saved effort', () => {
    expect(resolveAgyModelName(DEFAULT_AGY_MODEL, undefined))
      .toBe('Gemini 4 Hydrogen (Medium)');
    expect(resolveAgyModelName(DEFAULT_AGY_MODEL, 'ultra'))
      .toBe('Gemini 4 Hydrogen (Medium)');
    expect(resolveAgyModelName(AGY_GEMINI_4_CARBON_MODEL, 'xhigh'))
      .toBe('Gemini 4 Carbon (Medium)');
  });

  it('passes single-variant and saved legacy model names through', () => {
    expect(resolveAgyModelName(AGY_ORCHESTRATOR_CARBON_MODEL, 'high'))
      .toBe('Orchestrator (Carbon)');
    expect(resolveAgyModelName('Claude Opus 4.6 (Thinking)', 'high'))
      .toBe('Claude Opus 4.6 (Thinking)');
    expect(resolveAgyModelName('Gemini 3.6 Flash (High)', 'medium'))
      .toBe('Gemini 3.6 Flash (High)');
  });
});

describe('parseAgyModelsOutput', () => {
  it('parses tab-delimited and space-aligned agy models output while skipping spinner lines', () => {
    const sample = [
      '\u001b[2K⠋ Fetching available models...\r',
      'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
      'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
      'gemini-4-argon-high     Gemini 4 Argon (High)',
      'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
    ].join('\n');

    expect(parseAgyModelsOutput(sample)).toEqual([
      { code: 'Gemini 4 Neon (XHigh)', value: 'Gemini 4 Neon (XHigh)', description: 'gemini-4-neon-xhigh' },
      { code: 'Gemini 4 Hydrogen (High)', value: 'Gemini 4 Hydrogen (High)', description: 'gemini-4-hydrogen-high' },
      { code: 'Gemini 4 Argon (High)', value: 'Gemini 4 Argon (High)', description: 'gemini-4-argon-high' },
      { code: 'Orchestrator (Neon)', value: 'Orchestrator (Neon)', description: 'gemini-pro-orchestrator-neon' },
    ]);
  });
});
