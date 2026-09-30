import { describe, expect, it } from 'vitest';
import {
    applySessionModelPinPatch,
    applySessionModelPinTurn,
    createSessionModelPinPublisher,
    publishedSessionModelPin,
    type SessionModelPin,
} from './sessionModelPin';
import { MessageMetaSchema, type Metadata } from '@/api/types';

const NO_PIN: SessionModelPin = {};

function turn(overrides: Partial<Parameters<typeof applySessionModelPinTurn>[0]['turn']> = {}) {
    return {
        specifiesModel: false,
        specifiesEffort: false,
        ...overrides,
    };
}

describe('applySessionModelPinTurn', () => {
    it('publishes the pin the user chose', () => {
        const result = applySessionModelPinTurn({
            pin: NO_PIN,
            published: NO_PIN,
            turn: turn({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: true, effort: 'high' }),
        });
        expect(result.pin).toEqual({ model: 'claude-opus-5', effort: 'high' });
        expect(result.patch).toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' });
    });

    it('does not republish a pin that is already advertised', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: true, effort: 'high' }),
        });
        expect(result.patch).toBeNull();
    });

    // R2 — the highest-risk rule. A session with no pin runs the runtime default,
    // which is NOT a pin: advertising it would silently switch every client off
    // auto-routing for sessions the user never pinned.
    it('clears the advertised pin when the user resets to default', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ specifiesModel: true, model: undefined, specifiesEffort: true, effort: undefined }),
        });
        expect(result.pin).toEqual(NO_PIN);
        expect(result.patch).toEqual({ currentModelCode: null, currentThoughtLevelCode: null });
    });

    it('advertises nothing for a session that never had a pin', () => {
        const result = applySessionModelPinTurn({ pin: NO_PIN, published: NO_PIN, turn: turn() });
        expect(result.patch).toBeNull();
    });

    // R3 — a router pick must never become the session's pin, or the next client
    // reads it back as a user choice and auto-routing is frozen for good.
    it('ignores a model the client auto-routed', () => {
        const result = applySessionModelPinTurn({
            pin: NO_PIN,
            published: NO_PIN,
            turn: turn({
                specifiesModel: true,
                model: 'claude-sonnet-5',
                specifiesEffort: true,
                effort: 'medium',
                source: 'auto',
            }),
        });
        expect(result.pin).toEqual(NO_PIN);
        expect(result.patch).toBeNull();
    });

    // A client routes only when its own selection resolves to Auto/Default, so
    // an auto turn is the user going back to Auto. Desktop and mobile never send
    // `model: null` for a routable agent, so this is their only way to say it;
    // keeping the old pin left every other device showing — and re-sending as a
    // user pin — a model the user had just left.
    it('clears an existing pin when a later turn auto-routes', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ specifiesModel: true, model: 'claude-haiku-4-5', source: 'auto' }),
        });
        expect(result.pin).toEqual(NO_PIN);
        expect(result.patch).toEqual({ currentModelCode: null, currentThoughtLevelCode: null });
    });

    // Shared org routing: the client sends only the Auto marker and lets the CLI
    // pick the model, so the turn names no model at all.
    it('clears an existing pin on an auto turn that carries no model', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ source: 'auto' }),
        });
        expect(result.pin).toEqual(NO_PIN);
        expect(result.patch).toEqual({ currentModelCode: null, currentThoughtLevelCode: null });
    });

    // Absent marker = user pin, so desktop and web need no change.
    it('treats a missing source marker as a user pin', () => {
        const result = applySessionModelPinTurn({
            pin: NO_PIN,
            published: NO_PIN,
            turn: turn({ specifiesModel: true, model: 'claude-opus-5' }),
        });
        expect(result.pin).toEqual({ model: 'claude-opus-5' });
        expect(result.patch).toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: null });
    });

    it('leaves each half of the pin alone when the turn does not speak to it', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5', effort: 'high' },
            published: { model: 'claude-opus-5', effort: 'high' },
            turn: turn({ specifiesEffort: true, effort: 'max' }),
        });
        expect(result.pin).toEqual({ model: 'claude-opus-5', effort: 'max' });
        expect(result.patch).toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'max' });
    });

    it('converges when the advertised value drifted from the pin', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5' },
            published: { model: 'claude-haiku-4-5' },
            turn: turn(),
        });
        expect(result.patch).toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: null });
    });

    it('treats an empty model string as no pin', () => {
        const result = applySessionModelPinTurn({
            pin: { model: 'claude-opus-5' },
            published: { model: 'claude-opus-5' },
            turn: turn({ specifiesModel: true, model: '' }),
        });
        expect(result.pin).toEqual(NO_PIN);
        expect(result.patch).toEqual({ currentModelCode: null, currentThoughtLevelCode: null });
    });
});

describe('applySessionModelPinPatch', () => {
    const base = {
        path: '/tmp/p',
        host: 'h',
        homeDir: '/home/u',
        happyHomeDir: '/home/u/.happy',
        happyLibDir: '/home/u/.happy/lib',
        happyToolsDir: '/home/u/.happy/tools',
    } as const satisfies Partial<Metadata>;

    it('writes both codes', () => {
        expect(applySessionModelPinPatch(
            { ...base },
            { currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' },
        )).toEqual({ ...base, currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' });
    });

    // A key left in place would keep advertising a pin the user removed.
    it('deletes the keys rather than writing an empty value', () => {
        const result = applySessionModelPinPatch(
            { ...base, currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' },
            { currentModelCode: null, currentThoughtLevelCode: null },
        );
        expect(result).toEqual(base);
        expect('currentModelCode' in result).toBe(false);
        expect('currentThoughtLevelCode' in result).toBe(false);
    });

    it('does not mutate the metadata it was given', () => {
        const metadata = { ...base, currentModelCode: 'claude-opus-5' };
        applySessionModelPinPatch(metadata, { currentModelCode: null, currentThoughtLevelCode: null });
        expect(metadata.currentModelCode).toBe('claude-opus-5');
    });

    it('leaves unrelated metadata untouched', () => {
        expect(applySessionModelPinPatch(
            { ...base, models: [{ code: 'a', value: 'A' }], name: 'n' },
            { currentModelCode: 'b', currentThoughtLevelCode: null },
        )).toEqual({ ...base, models: [{ code: 'a', value: 'A' }], name: 'n', currentModelCode: 'b' });
    });
});

describe('publishedSessionModelPin', () => {
    const base = {
        path: '/tmp/p',
        host: 'h',
        homeDir: '/home/u',
        happyHomeDir: '/home/u/.happy',
        happyLibDir: '/home/u/.happy/lib',
        happyToolsDir: '/home/u/.happy/tools',
    } as const satisfies Partial<Metadata>;

    it('reads both advertised codes', () => {
        expect(publishedSessionModelPin({ ...base, currentModelCode: 'claude-opus-5', currentThoughtLevelCode: 'high' }))
            .toEqual({ model: 'claude-opus-5', effort: 'high' });
    });

    it('reads an unpinned session as no pin', () => {
        expect(publishedSessionModelPin({ ...base })).toEqual({});
    });

    // Seeded from the session snapshot at startup, which may not exist yet.
    it('tolerates missing metadata', () => {
        expect(publishedSessionModelPin(undefined)).toEqual({});
    });
});

describe('createSessionModelPinPublisher', () => {
    const metadata: Metadata = {
        path: '/tmp/p',
        host: 'h',
        homeDir: '/home/u',
        happyHomeDir: '/home/u/.happy',
        happyLibDir: '/home/u/.happy/lib',
        happyToolsDir: '/home/u/.happy/tools',
    };

    function harness(initialPin: SessionModelPin = {}, publishedPin: SessionModelPin = {}) {
        const written: Metadata[] = [];
        let current: Metadata = { ...metadata, ...(publishedPin.model ? { currentModelCode: publishedPin.model } : {}) };
        const publisher = createSessionModelPinPublisher({
            initialPin,
            publishedPin,
            updateMetadata: (update) => {
                current = update(current);
                written.push(current);
            },
        });
        return { publisher, written, latest: () => current };
    }

    it('advertises a spawn-time pin on the startup converge call', () => {
        const { publisher, written, latest } = harness({ model: 'opus', effort: 'high' });
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(written).toHaveLength(1);
        expect(latest().currentModelCode).toBe('opus');
        expect(latest().currentThoughtLevelCode).toBe('high');
    });

    it('stays silent for a session with no pin', () => {
        const { publisher, written } = harness();
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(written).toHaveLength(0);
    });

    it('writes once when the user pins, and not again on repeat turns', () => {
        const { publisher, written } = harness();
        publisher.publish({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: false });
        publisher.publish({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: false });
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(written).toHaveLength(1);
    });

    it('deletes the advertised codes when the user resets to default', () => {
        const { publisher, latest } = harness({ model: 'claude-opus-5' }, { model: 'claude-opus-5' });
        publisher.publish({ specifiesModel: true, model: undefined, specifiesEffort: false });
        expect('currentModelCode' in latest()).toBe(false);
    });

    // The regression this whole feature turns on: a router pick must leave no trace.
    it('writes nothing for an auto-routed turn', () => {
        const { publisher, written } = harness();
        publisher.publish({ specifiesModel: true, model: 'claude-sonnet-5', specifiesEffort: true, effort: 'medium', source: 'auto' });
        publisher.publish({ specifiesModel: true, model: 'claude-haiku-4-5', specifiesEffort: true, effort: 'low', source: 'auto' });
        expect(written).toHaveLength(0);
    });

    it('deletes the advertised codes when the user goes back to Auto', () => {
        const { publisher, written, latest } = harness();
        publisher.publish({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: true, effort: 'high', source: 'user' });
        publisher.publish({ specifiesModel: true, model: 'claude-sonnet-5', specifiesEffort: true, effort: 'medium', source: 'auto' });
        publisher.publish({ specifiesModel: true, model: 'claude-haiku-4-5', specifiesEffort: true, effort: 'low', source: 'auto' });
        expect(written).toHaveLength(2);
        expect('currentModelCode' in latest()).toBe(false);
        expect('currentThoughtLevelCode' in latest()).toBe(false);
    });

    it('restores the spawn-time pin after an abort reset', () => {
        const { publisher, latest } = harness({ model: 'opus' }, { model: 'opus' });
        publisher.publish({ specifiesModel: true, model: 'claude-haiku-4-5', specifiesEffort: false });
        expect(latest().currentModelCode).toBe('claude-haiku-4-5');
        publisher.reset();
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(latest().currentModelCode).toBe('opus');
    });

    it('reports each published patch to the caller', () => {
        const seen: unknown[] = [];
        const publisher = createSessionModelPinPublisher({
            initialPin: {},
            publishedPin: {},
            updateMetadata: () => {},
            onPublish: (patch) => seen.push(patch),
        });
        publisher.publish({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: false });
        expect(seen).toEqual([{ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: null }]);
    });
});

describe('createSessionModelPinPublisher restart and reset convergence', () => {
    const metadata: Metadata = {
        path: '/tmp/p',
        host: 'h',
        homeDir: '/home/u',
        happyHomeDir: '/home/u/.happy',
        happyLibDir: '/home/u/.happy/lib',
        happyToolsDir: '/home/u/.happy/tools',
    };

    function harness(initialPin: SessionModelPin, publishedPin: SessionModelPin) {
        const written: Array<Metadata> = [];
        let current: Metadata = {
            ...metadata,
            ...(publishedPin.model ? { currentModelCode: publishedPin.model } : {}),
            ...(publishedPin.effort ? { currentThoughtLevelCode: publishedPin.effort } : {}),
        };
        const publisher = createSessionModelPinPublisher({
            initialPin,
            publishedPin,
            updateMetadata: (update) => {
                current = update(current);
                written.push(current);
            },
        });
        return { publisher, written, latest: () => current };
    }

    // The whole point of the feature is that a pin survives. A CLI restart or
    // daemon reconnect spawns without --model, and the runtime knowing nothing
    // is not the user clearing their choice: publishing a clear here wipes the
    // pin every other device was reading.
    it('does not wipe an advertised pin when the runtime restarts without one', () => {
        // A restart/reconnect spawns with no --model, so the spawn-time pin is
        // empty while the session still advertises what the user chose.
        const { publisher, written, latest } = harness({}, { model: 'claude-opus-5', effort: 'high' });
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(written).toHaveLength(0);
        expect(latest().currentModelCode).toBe('claude-opus-5');
        expect(latest().currentThoughtLevelCode).toBe('high');
    });

    // An explicit --model at spawn IS a fresh user choice and must win over
    // whatever the session advertised before.
    it('lets an explicit spawn pin replace the advertised one', () => {
        const { publisher, latest } = harness({ model: 'claude-haiku-4-5' }, { model: 'claude-opus-5' });
        publisher.publish({ specifiesModel: false, specifiesEffort: false });
        expect(latest().currentModelCode).toBe('claude-haiku-4-5');
    });

    // reset() restores the spawn-time pin in memory; leaving the advertised
    // value stale lets another device read the old pin and send it straight
    // back as a user pin, silently undoing the reset.
    it('converges the advertised pin when an abort resets it', () => {
        const { publisher, latest } = harness({}, {});
        publisher.publish({ specifiesModel: true, model: 'claude-opus-5', specifiesEffort: false });
        expect(latest().currentModelCode).toBe('claude-opus-5');
        publisher.reset();
        expect('currentModelCode' in latest()).toBe(false);
    });
});

// The schema and the pin decision are two halves of one contract: the loops feed
// a parsed meta straight into applySessionModelPinTurn. Testing them apart let a
// marker the schema could not read still arrive as "no marker", which the pin
// logic reads as a deliberate user pin.
describe('MessageMetaSchema + applySessionModelPinTurn, composed', () => {
    function publishFor(rawMeta: unknown) {
        const meta = MessageMetaSchema.parse(rawMeta);
        return applySessionModelPinTurn({
            pin: {},
            published: {},
            turn: {
                specifiesModel: Object.prototype.hasOwnProperty.call(meta, 'model'),
                model: meta.model ?? undefined,
                specifiesEffort: Object.prototype.hasOwnProperty.call(meta, 'effort'),
                effort: meta.effort ?? undefined,
                source: meta.modelSource,
            },
        });
    }

    it('records a model the user pinned', () => {
        expect(publishFor({ model: 'claude-opus-5', modelSource: 'user' }).patch)
            .toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: null });
    });

    it('records a model from a client that sends no marker at all', () => {
        expect(publishFor({ model: 'claude-opus-5' }).patch)
            .toEqual({ currentModelCode: 'claude-opus-5', currentThoughtLevelCode: null });
    });

    it('never records a model the client marked as auto-routed', () => {
        expect(publishFor({ model: 'claude-sonnet-5', modelSource: 'auto' }).patch).toBeNull();
    });

    // The case this composed test exists for: an unknown marker is not "no
    // marker". A client that names a provenance we cannot read must not have its
    // model frozen onto the session as a user pin.
    it('never records a model whose marker it cannot read', () => {
        expect(publishFor({ model: 'claude-sonnet-5', modelSource: 'router-v2' }).patch).toBeNull();
        expect(publishFor({ model: 'claude-sonnet-5', modelSource: 42 }).patch).toBeNull();
        expect(publishFor({ model: 'claude-sonnet-5', modelSource: null }).patch).toBeNull();
    });

    it('still routes the message when the marker is unreadable', () => {
        const meta = MessageMetaSchema.parse({ permissionMode: 'default', model: 'x', modelSource: 'router-v2' });
        expect(meta.permissionMode).toBe('default');
        expect(meta.model).toBe('x');
    });
});
