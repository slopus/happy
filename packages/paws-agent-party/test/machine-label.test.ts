import { expect, it } from 'vitest';
import { machineLabel } from '../src/web/machine-label.js';

it('shows hostnames and connectivity instead of opaque machine ids', () => {
  expect(machineLabel({ id: '12345678-abcd-efgh', active: true, metadata: { host: 'jackyMac-mini.local' } })).toBe('jackyMac-mini.local · 在线');
  expect(machineLabel({ id: '12345678-abcd-efgh', active: false, metadata: { displayName: '工作电脑', host: 'mini.local' } })).toBe('工作电脑（mini.local） · 离线');
});

it('handles absent or malformed decrypted metadata without exposing raw objects', () => {
  for (const metadata of [null, undefined, 'encrypted', {}, { host: 42 }, { host: '   ', displayName: [] }]) {
    expect(machineLabel({ id: '12345678-abcd-efgh', active: true, metadata })).toBe('未命名设备 · 12345678… · 在线');
  }
  expect(machineLabel({ id: 'tiny', active: true, metadata: { host: ' mini.local ', displayName: 'mini.local' } })).toBe('mini.local · 在线');
});
