/** Opt-in native test: unpack into a fresh disposable project, never edit the input archive. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createMotionWorkbenchHandlers, resolveMotionProject } from './bridge';
import { createMotionProjectCatalog } from './catalog';
import { createMotionEditor } from './editor';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

const executable = process.env.PAWS_MOTIONHARNESS_BIN;
const archivePath = process.env.PAWS_MOTIONHARNESS_TEST_ARCHIVE;
const execute = promisify(execFile);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!executable || !archivePath)('installed MotionHarness review roundtrip', () => {
    it('preserves the full native document, bundles an isolated editor and keeps bindings private', async () => {
        if (!executable || !archivePath) throw new Error('Native fixture settings missing');
        const root = await realpath(await mkdtemp(join(tmpdir(), 'paws-studio-native-'))), project = join(root, 'project');
        const options = { cwd: root, env: { ...process.env, MH_NO_BROWSER: '1', MH_NO_UPDATE_NOTIFIER: '1' }, timeout: 30000, maxBuffer: 1024 * 1024 };
        let changed: () => void = () => {};
        const change = new Promise<void>(resolve => { changed = resolve; });
        const catalogDirectory = join(root, 'private-index');
        const editor = createMotionEditor(root, { executable, catalogDirectory, onChange: () => changed() });
        const foreign = createMotionEditor(root, { executable, catalogDirectory });
        try {
            await execute(executable, ['unpack', await realpath(archivePath), project], options);
            const opened = await editor.open({ projectPath: project });
            expect(opened.ok).toBe(true); if (!opened.ok) throw new Error(JSON.stringify(opened));
            const descriptor = opened.value;
            const doc = z.object({ revision: z.number(), rootInstanceId: z.string(), settings: z.object({ width: z.number(), height: z.number(), duration: z.number() }), instances: z.record(z.string(), z.unknown()) }).parse(descriptor.state.document);
            expect(doc.settings).toMatchObject({ width: 1440, height: 1152, duration: 8.5 });
            expect(Object.keys(doc.instances).length).toBeGreaterThanOrEqual(44);
            expect(descriptor.state.projectEntry).toBeUndefined(); expect(descriptor.state.studioSessions).toBeUndefined();
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < descriptor.bundle.bytes;) {
                const result = await editor.resource({ bindingId: descriptor.bindingId, resourceId: 'bundle', offset });
                expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result));
                const bytes = Buffer.from(result.value.dataBase64, 'base64'); chunks.push(bytes); offset += bytes.length;
                expect(result.value.done).toBe(offset === descriptor.bundle.bytes);
            }
            const bytes = Buffer.concat(chunks); expect(sha256(bytes)).toBe(descriptor.bundle.sha256);
            const bundle = JSON.parse(gunzipSync(bytes).toString('utf8'));
            expect(bundle.script).toContain('paws-motion-connect'); expect(bundle.licenseText).toContain('GNU GENERAL PUBLIC LICENSE');
            expect(bundle.script).not.toMatch(/\/s\/[a-f0-9]{32,}\/api/);
            expect(await foreign.state({ bindingId: descriptor.bindingId })).toMatchObject({ ok: false, error: { code: 'BINDING_NOT_FOUND' } });
            expect(await editor.resource({ bindingId: descriptor.bindingId, resourceId: 'asset:' + '0'.repeat(64), offset: 0 })).toMatchObject({ ok: false, error: { code: 'RESOURCE_NOT_FOUND' } });
            expect(await editor.operation({ bindingId: descriptor.bindingId, route: 'project/launch', body: { path: '/outside' } })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
            const renamed = await editor.operation({ bindingId: descriptor.bindingId, route: 'rename', body: { title: 'Paws embedded native test', expectedRevision: doc.revision, expectedBuildId: descriptor.state.buildId } });
            expect(renamed.ok).toBe(true); if (!renamed.ok) throw new Error(JSON.stringify(renamed));
            expect(renamed.value.document).toMatchObject({ title: 'Paws embedded native test', instances: expect.any(Object) });
            const catalog = createMotionProjectCatalog(root, resolveMotionProject, catalogDirectory);
            expect((await catalog.list()).projects).toEqual([expect.objectContaining({ projectPath: project, title: 'Paws embedded native test', lastOpenedAt: expect.any(Number) })]);
            await Promise.race([change, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('No native document event')), 3000); timer.unref(); })]);
            expect(await editor.close({ bindingId: descriptor.bindingId })).toEqual({ ok: true, value: { closed: true } });
            expect(await editor.state({ bindingId: descriptor.bindingId })).toMatchObject({ ok: false, error: { code: 'BINDING_NOT_FOUND' } });
        } finally {
            editor.dispose(); foreign.dispose();
            await execute(executable, ['close', '--project', project], options).catch(() => {});
            await rm(root, { recursive: true, force: true });
        }
    }, 120000);
    it('reads a real annotation, prepares without saving and rejects an edited instruction', async () => {
        if (!executable || !archivePath) throw new Error('Set PAWS_MOTIONHARNESS_BIN and PAWS_MOTIONHARNESS_TEST_ARCHIVE');
        const archive = await realpath(archivePath);
        const before = sha256(await readFile(archive));
        const root = await realpath(await mkdtemp(join(tmpdir(), 'paws-motion-native-')));
        const project = join(root, 'project');
        const options = { cwd: root, env: { ...process.env, MH_NO_BROWSER: '1', MH_NO_UPDATE_NOTIFIER: '1' }, timeout: 30000, maxBuffer: 1024 * 1024 };
        let engineStarted = false;
        try {
            await execute(executable, ['unpack', archive, project], options);
            // A CLI command may start the engine even if its response is lost.
            engineStarted = true;
            const created = await execute(executable, ['marker', 'edit', '--project', project, '--json', JSON.stringify({
                operation: 'upsert', markers: [{ id: 'paws-integration-test', label: 'Paws integration fixture', notes: 'Verify the review bridge only.',
                    timeSpace: 'project', start: 1.6, origin: 'user', anchor: { x: 500, y: 300, width: 120, height: 80 }, onResolve: 'keep' }],
            })], options);
            expect(JSON.parse(created.stdout).displayed).toBe(false);
            const handlers = createMotionWorkbenchHandlers(root, executable);
            const first = await handlers.inspect({ projectPath: project });
            expect(first.ok).toBe(true);
            if (!first.ok) throw new Error(JSON.stringify(first));
            const marker = first.value.markers.find(item => item.id === 'paws-integration-test');
            expect(marker).toBeDefined();
            if (!marker) throw new Error('Native test annotation missing');
            expect(marker.anchor).toEqual({ x: 500, y: 300, width: 120, height: 80 });
            const request = { projectPath: project, projectId: first.value.projectId, snapshotHash: first.value.snapshotHash,
                markers: [{ id: marker.id, requestVersion: marker.requestVersion }] };
            const prepared = await handlers.prepareReview(request);
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) throw new Error(JSON.stringify(prepared));
            expect(prepared.value.prompt).toContain(marker.label);
            const afterPrepare = await handlers.inspect({ projectPath: project });
            expect(afterPrepare).toEqual(first);
            await execute(executable, ['marker', 'edit', '--project', project, '--json', JSON.stringify({
                operation: 'upsert', markers: [{ id: marker.id, notes: 'The user changed the review while it was open.' }],
            })], options);
            expect(await handlers.prepareReview(request)).toMatchObject({ ok: false, error: { code: 'STALE_REVIEW' } });
            const next = await handlers.inspect({ projectPath: project });
            expect(next.ok).toBe(true);
            if (!next.ok) throw new Error(JSON.stringify(next));
            expect(next.value.snapshotHash).not.toBe(first.value.snapshotHash);
            expect(next.value.markers.find(item => item.id === marker.id)?.requestVersion).not.toBe(marker.requestVersion);
            expect(sha256(await readFile(archive))).toBe(before);
        } finally {
            if (engineStarted) await execute(executable, ['close', '--project', project], options);
            await rm(root, { recursive: true, force: true });
        }
    }, 120000);
});
