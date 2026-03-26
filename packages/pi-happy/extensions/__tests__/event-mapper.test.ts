import { describe, expect, it, vi, afterEach } from 'vitest';

import { PiSessionMapper } from '../event-mapper';

describe('PiSessionMapper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts and ends turns with the same generated turn id', () => {
    const mapper = new PiSessionMapper();

    const [turnStart] = mapper.startTurn();
    expect(turnStart).toMatchObject({
      role: 'agent',
      ev: { t: 'turn-start' },
    });
    expect(typeof turnStart.turn).toBe('string');
    expect(turnStart.turn).toBeTruthy();

    expect(mapper.startTurn()).toEqual([]);

    const [turnEnd] = mapper.endTurn('completed');
    expect(turnEnd).toMatchObject({
      role: 'agent',
      turn: turnStart.turn,
      ev: { t: 'turn-end', status: 'completed' },
    });

    const [nextTurnStart] = mapper.startTurn();
    expect(nextTurnStart.turn).not.toBe(turnStart.turn);
  });

  it('defaults turn end status to completed when no explicit status is provided', () => {
    const mapper = new PiSessionMapper();

    mapper.startTurn();

    const [turnEnd] = mapper.endTurn();
    expect(turnEnd.ev).toEqual({ t: 'turn-end', status: 'completed' });
  });

  it('batches multiple output deltas into a single text envelope on flush', () => {
    const mapper = new PiSessionMapper();
    const [turnStart] = mapper.startTurn();

    expect(mapper.mapTextDelta('Hello')).toEqual([]);
    expect(mapper.mapTextDelta(' world')).toEqual([]);

    const [textEnvelope] = mapper.flush();
    expect(textEnvelope).toMatchObject({
      role: 'agent',
      turn: turnStart.turn,
      ev: { t: 'text', text: 'Hello world' },
    });
    expect('thinking' in textEnvelope.ev).toBe(false);
    expect(mapper.flush()).toEqual([]);
  });

  it('flushes output when switching to thinking and flushes thinking when switching back to output', () => {
    const mapper = new PiSessionMapper();
    const [turnStart] = mapper.startTurn();

    mapper.mapTextDelta('Answer');
    const switchedToThinking = mapper.mapThinkingDelta('Need to check');
    expect(switchedToThinking).toHaveLength(1);
    expect(switchedToThinking[0]).toMatchObject({
      turn: turnStart.turn,
      ev: { t: 'text', text: 'Answer' },
    });

    mapper.mapThinkingDelta(' more');
    const switchedBackToOutput = mapper.mapTextDelta('Final answer');
    expect(switchedBackToOutput).toHaveLength(1);
    expect(switchedBackToOutput[0]).toMatchObject({
      turn: turnStart.turn,
      ev: { t: 'text', text: 'Need to check more', thinking: true },
    });

    const [finalOutput] = mapper.flush();
    expect(finalOutput).toMatchObject({
      turn: turnStart.turn,
      ev: { t: 'text', text: 'Final answer' },
    });
  });

  it('flushes pending text before tool start and reuses the same call id for tool end', () => {
    const mapper = new PiSessionMapper();
    const [turnStart] = mapper.startTurn();

    mapper.mapTextDelta('\nRunning tool next\n');

    const startEnvelopes = mapper.mapToolStart('tool-call-1', 'bash', { command: 'ls -la' });
    expect(startEnvelopes).toHaveLength(2);
    expect(startEnvelopes[0]).toMatchObject({
      turn: turnStart.turn,
      ev: { t: 'text', text: 'Running tool next' },
    });
    expect(startEnvelopes[1]).toMatchObject({
      turn: turnStart.turn,
      role: 'agent',
      ev: {
        t: 'tool-call-start',
        name: 'bash',
        title: 'bash',
        description: 'Running bash',
        args: { command: 'ls -la' },
      },
    });
    const startCallId = startEnvelopes[1].ev.t === 'tool-call-start' ? startEnvelopes[1].ev.call : null;
    expect(startCallId).toBeTruthy();

    const [endEnvelope] = mapper.mapToolEnd('tool-call-1');
    expect(endEnvelope).toMatchObject({
      turn: turnStart.turn,
      role: 'agent',
      ev: {
        t: 'tool-call-end',
        call: startCallId,
      },
    });
  });

  it('drops whitespace-only pending chunks after trimming surrounding newlines', () => {
    const mapper = new PiSessionMapper();

    mapper.mapThinkingDelta('\n\n');

    expect(mapper.flush()).toEqual([]);
  });

  it('ignores tool end events that have no matching tool start', () => {
    const mapper = new PiSessionMapper();
    const [turnStart] = mapper.startTurn();

    mapper.mapTextDelta('hello');

    const envelopes = mapper.mapToolEnd('missing-tool-call');
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      turn: turnStart.turn,
      ev: { t: 'text', text: 'hello' },
    });
  });

  it('uses monotonic envelope times even when Date.now does not advance', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    const mapper = new PiSessionMapper();
    const times = [
      mapper.startTurn()[0].time,
      mapper.mapTextDelta('hello')[0]?.time,
      mapper.flush()[0].time,
      mapper.mapToolStart('tool-1', 'bash', { command: 'pwd' })[0].time,
      mapper.mapToolEnd('tool-1')[0].time,
      mapper.endTurn('cancelled')[0].time,
    ].filter((time): time is number => typeof time === 'number');

    expect(times).toEqual([1_000, 1_001, 1_002, 1_003, 1_004]);
    expect(times.every((time, index) => index === 0 || time > times[index - 1]!)).toBe(true);
  });

  it('flushes pending output before emitting turn-end', () => {
    const mapper = new PiSessionMapper();
    const [turnStart] = mapper.startTurn();

    mapper.mapTextDelta('done');

    const envelopes = mapper.endTurn('cancelled');
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      turn: turnStart.turn,
      ev: { t: 'text', text: 'done' },
    });
    expect(envelopes[1]).toMatchObject({
      turn: turnStart.turn,
      ev: { t: 'turn-end', status: 'cancelled' },
    });
  });
});
