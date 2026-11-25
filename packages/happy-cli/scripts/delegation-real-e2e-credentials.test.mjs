import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseHarnessOwnerCredentials, resolveHarnessMachineEncryption, resolveHarnessSessionEncryption } from './delegation-real-e2e-credentials.mjs';

const encoded = byte => Buffer.alloc(32, byte).toString('base64');
const dataOwner = () => parseHarnessOwnerCredentials({ token: 'synthetic-token', encryption: { publicKey: encoded(1), machineKey: encoded(2) } }, () => { throw new Error('Owner-secret derivation must not run'); });

test('supports existing owner-secret credentials without a retained-session read', async () => {
    const owner = parseHarnessOwnerCredentials({ token: 'synthetic-token', secret: encoded(3) }, secret => ({ secretKey: secret, publicKey: new Uint8Array(32) }));
    const expected = { key: new Uint8Array(32).fill(3), variant: 'legacy' };
    const resolved = await resolveHarnessSessionEncryption({ id: 'new-parent', dataEncryptionKey: null }, {
        owner, knownSessions: new Set(['new-parent']), resolveRecordEncryption: (_record, credentials, kind) => {
            assert.equal(kind, 'session'); assert.equal(credentials.secret.length, 32); return expected;
        }, readRetained: () => { throw new Error('Legacy owner must not read retained sessions'); },
    });
    assert.equal(resolved, expected);
});

test('uses the explicitly supplied CLI machineKey for a dataKey machine', () => {
    const owner = dataOwner();
    const result = resolveHarnessMachineEncryption({ id: 'selected-machine', dataEncryptionKey: 'server-wrapped-key' }, owner, () => { throw new Error('No owner-secret decryption'); });
    assert.deepEqual(result, { key: new Uint8Array(32).fill(2), variant: 'dataKey' });
    assert.throws(() => resolveHarnessMachineEncryption({ id: 'selected-machine', dataEncryptionKey: null }, owner), /legacy machine/);
});

test('reads only the known new session key and variant without inspecting metadata or enumerating older sessions', async () => {
    let reads = 0;
    const newEntry = { encryptionKey: encoded(4), encryptionVariant: 'dataKey', get metadata() { throw new Error('Metadata must not be read'); } };
    const retained = { sessions: new Proxy({}, {
        get(_target, id) { assert.equal(id, 'new-child'); return newEntry; },
        ownKeys() { throw new Error('Older session IDs must not be enumerated'); },
    }) };
    const result = await resolveHarnessSessionEncryption({ id: 'new-child', dataEncryptionKey: 'server-wrapped-key' }, {
        owner: dataOwner(), knownSessions: new Set(['new-child']), readRetained: async () => { reads++; return retained; },
    });
    assert.equal(reads, 1);
    assert.deepEqual(result, { key: new Uint8Array(32).fill(4), variant: 'dataKey' });
});

test('rejects foreign sessions before reading retained state, and rejects missing or mismatched new keys', async () => {
    const base = { owner: dataOwner(), knownSessions: new Set(['new-child']), readRetained: () => { throw new Error('Retained state must not be read'); } };
    await assert.rejects(resolveHarnessSessionEncryption({ id: 'old-session' }, base), /outside this run/);
    await assert.rejects(resolveHarnessSessionEncryption({ id: 'new-child', dataEncryptionKey: 'wrapped' }, { ...base, readRetained: async () => ({ sessions: {} }) }), /no retained/);
    await assert.rejects(resolveHarnessSessionEncryption({ id: 'new-child', dataEncryptionKey: 'wrapped' }, {
        ...base, readRetained: async () => ({ sessions: { 'new-child': { encryptionKey: encoded(4), encryptionVariant: 'legacy' } } }),
    }), /variant does not match/);
});

test('rejects malformed private key values without including their contents in errors', () => {
    const privateValue = 'synthetic-private-key-value';
    try {
        parseHarnessOwnerCredentials({ token: 'synthetic-token', encryption: { publicKey: encoded(1), machineKey: privateValue } }, () => {});
        assert.fail('Expected invalid key rejection');
    } catch (error) { assert(!error.message.includes(privateValue)); }
});

test('default dry run does not read even explicitly supplied nonexistent private paths', () => {
    const script = fileURLToPath(new URL('./delegation-real-e2e.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--credentials', '/nonexistent/private-owner.json', '--retained-sessions', '/nonexistent/sessions.json'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.mode, 'dry-run'); assert.equal(plan.connects, false); assert.equal(plan.startsWorkers, false);
    assert.equal(result.stderr, '');
});

test('initialization failures expose no supplied argument values or stack trace', () => {
    const script = fileURLToPath(new URL('./delegation-real-e2e.mjs', import.meta.url));
    const privateValue = 'synthetic-private-argument';
    const result = spawnSync(process.execPath, [script, '--run', '--credentials', privateValue], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert(!result.stderr.includes(privateValue)); assert(!result.stderr.includes(' at '));
});
