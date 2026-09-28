import { expect, test } from 'vitest';
import { pawsAccountServerUrl, pawsWebOrigin } from '../src/web/paws-origin.js';

test('keeps staging AgentParty login and session links on the independent Web site', () => {
  expect(pawsWebOrigin('https://47.115.228.20:8444')).toBe('https://47.115.228.20:8444');
  expect(pawsWebOrigin('https://47.115.228.20:8443')).toBe('https://47.115.228.20:8443');
  expect(pawsWebOrigin('https://untrusted.invalid')).toBe('https://47.115.228.20:8443');
});

test('maps only the shared production account gateway to staging in session links', () => {
  expect(pawsAccountServerUrl('https://47.115.228.20:8443', 'https://47.115.228.20:8444')).toBe('https://47.115.228.20:8444');
  expect(pawsAccountServerUrl('https://47.115.228.20:8443/', 'https://47.115.228.20:8444')).toBe('https://47.115.228.20:8444');
  expect(pawsAccountServerUrl('https://47.115.228.20:8443', 'https://47.115.228.20:8443')).toBe('https://47.115.228.20:8443');
  expect(pawsAccountServerUrl('https://custom.example', 'https://47.115.228.20:8444')).toBe('https://custom.example');
});
