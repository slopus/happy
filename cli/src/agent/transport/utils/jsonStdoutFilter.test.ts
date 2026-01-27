import { describe, expect, it } from 'vitest';

import { filterJsonObjectOrArrayLine } from './jsonStdoutFilter';

describe('filterJsonObjectOrArrayLine', () => {
  it('drops empty and whitespace lines', () => {
    expect(filterJsonObjectOrArrayLine('')).toBeNull();
    expect(filterJsonObjectOrArrayLine('   \n')).toBeNull();
  });

  it('drops non-JSON lines', () => {
    expect(filterJsonObjectOrArrayLine('hello world')).toBeNull();
    expect(filterJsonObjectOrArrayLine('INFO: started')).toBeNull();
  });

  it('drops JSON primitives', () => {
    expect(filterJsonObjectOrArrayLine('42')).toBeNull();
    expect(filterJsonObjectOrArrayLine('"ok"')).toBeNull();
    expect(filterJsonObjectOrArrayLine('true')).toBeNull();
    expect(filterJsonObjectOrArrayLine('null')).toBeNull();
  });

  it('keeps JSON objects and arrays', () => {
    expect(filterJsonObjectOrArrayLine('{"jsonrpc":"2.0","method":"x"}\n')).toBe('{"jsonrpc":"2.0","method":"x"}\n');
    expect(filterJsonObjectOrArrayLine('[{"jsonrpc":"2.0","method":"x"}]\n')).toBe('[{"jsonrpc":"2.0","method":"x"}]\n');
  });

  it('drops invalid JSON that looks like JSON', () => {
    expect(filterJsonObjectOrArrayLine('{not json}\n')).toBeNull();
    expect(filterJsonObjectOrArrayLine('[1,\n')).toBeNull();
  });
});

