import { describe, expect, it } from 'vitest';
import { extractMcpToolCallResultOutput } from '../runCodex';

describe('extractMcpToolCallResultOutput', () => {
  it('prefers Ok when present (including falsy values)', () => {
    expect(extractMcpToolCallResultOutput({ Ok: false })).toBe(false);
    expect(extractMcpToolCallResultOutput({ Ok: 0 })).toBe(0);
    expect(extractMcpToolCallResultOutput({ Ok: '' })).toBe('');
    expect(extractMcpToolCallResultOutput({ Ok: null })).toBeNull();
  });

  it('prefers Err when Ok is absent (including falsy values)', () => {
    expect(extractMcpToolCallResultOutput({ Err: false })).toBe(false);
    expect(extractMcpToolCallResultOutput({ Err: 0 })).toBe(0);
    expect(extractMcpToolCallResultOutput({ Err: '' })).toBe('');
    expect(extractMcpToolCallResultOutput({ Err: null })).toBeNull();
  });

  it('returns result as-is when it is not an Ok/Err object', () => {
    expect(extractMcpToolCallResultOutput(false)).toBe(false);
    expect(extractMcpToolCallResultOutput(0)).toBe(0);
    expect(extractMcpToolCallResultOutput('')).toBe('');
    expect(extractMcpToolCallResultOutput(null)).toBeNull();
    expect(extractMcpToolCallResultOutput({ value: 1 })).toEqual({ value: 1 });
  });
});

