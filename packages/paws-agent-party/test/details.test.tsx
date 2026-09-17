// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AgentDetails } from '../src/web/AgentDetails.js';
import type { RunSnapshot } from '../src/contracts.js';
import type { Api } from '../src/web/api.js';
afterEach(cleanup);
it('pages durable records by received seq and displays only the chosen role provenance', async () => {
  const requests: string[] = [];
  const api = (async (path: string) => {
    requests.push(path);
    const second = path.includes('afterSeq=2');
    return { sessionId: 's-trend', status: 'completed', requests: [{ id: 'permission', tool: 'shell' }], hasMore: !second,
      messages: second ? [{ id: 'm-3', seq: 3, content: { role: 'user' } }] : [{ id: 'm-2', seq: 2, content: { role: 'session', content: { id: 'root-trend:end', time: 2, role: 'agent', turn: 'root-trend', ev: { t: 'turn-end', status: 'completed' } } } }] };
  }) as Api;
  const run = { id: 'r', partyId: 'party', roles: { trend30: { sessionId: 's-trend', status: 'completed' } }, turns: [
    { runId: 'r', partyId: 'party', participant: 'trend30', taskMessageId: 'task-trend', publicMessageId: 'public-trend', localId: 'local-trend', sessionId: 's-trend', rootTurnId: 'root-trend', sourceMessageId: 'm-2' },
    { runId: 'r', partyId: 'party', participant: 'timing1', taskMessageId: 'wrong-role' },
  ] } as unknown as RunSnapshot;
  render(<AgentDetails run={run} role="trend30" api={api} onClose={() => {}} />);
  expect(await screen.findByText('m-2')).toBeTruthy();
  expect(await screen.findByText('#2 · turn-end · completed')).toBeTruthy();
  expect(screen.getByText('public-trend')).toBeTruthy();
  expect(screen.queryByText('wrong-role')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '加载下一页' }));
  await screen.findByText(/#3/);
  expect(requests.at(-1)).toContain('afterSeq=2');
  expect(screen.getByText(/待授权/)).toBeTruthy();
});
