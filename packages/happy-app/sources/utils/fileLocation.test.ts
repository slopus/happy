import { expect, it } from 'vitest';
import { filePathWithLocation, fileLocationSelection } from './fileLocation';
it('preserves valid legacy locations and replaces inline locations without duplicating them', () => {
    expect(filePathWithLocation('/a.ts', '12', '3')).toBe('/a.ts:12:3');
    expect(filePathWithLocation('C:/a.ts:2:8', '12')).toBe('C:/a.ts:12');
    expect(filePathWithLocation('/a.ts', undefined, '3')).toBe('/a.ts:1:3');
    expect(filePathWithLocation('/a.ts:2', 'abc', '-1')).toBe('/a.ts:2');
});
it('selects a complete requested line or the requested column, clamped to CRLF content', () => {
    expect(fileLocationSelection('abc\r\nhello\r\nz', { line: 2, column: null })).toEqual({ line: 2, start: 4, end: 9 });
    expect(fileLocationSelection('abc\r\nhello\r\nz', { line: 2, column: 3 })).toEqual({ line: 2, start: 6, end: 6 });
    expect(fileLocationSelection('abc\nz', { line: 999, column: 999 })).toEqual({ line: 2, start: 5, end: 5 });
});
