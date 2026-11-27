import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { GOAL_CANVAS_LIMITS } from '@slopus/happy-wire';

const count = 29;
const missingPreviews = 3;
const preview = '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAYACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAEG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AtgKzgAAAAAD/2Q==';
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function chunk(type, data) {
    const buffer = Buffer.alloc(12 + data.length);
    buffer.writeUInt32BE(data.length);
    buffer.write(type, 4, 'ascii');
    data.copy(buffer, 8);
    buffer.writeUInt32BE(crc32(buffer.subarray(4, 8 + data.length)), 8 + data.length);
    return buffer;
}

function image(index) {
    const large = index < missingPreviews;
    const [width, height] = large ? [704, 528] : [80, 60];
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const rowBytes = 1 + 3 * width;
    const raster = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * rowBytes + 1 + 3 * x;
            raster[pixel] = (index * 19 + x * 3) % 256;
            raster[pixel + 1] = (index * 23 + y * 5) % 256;
            raster[pixel + 2] = (index * 7 + x + y) % 256;
        }
    }
    return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raster, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

export async function seedCanvasMarkAssets(canvas, projectPath) {
    let snapshot;
    for (const [index, name] of ['标注测试 A.png', '标注测试 B.png'].entries()) {
        const result = await canvas.import({
            projectPath, name, mimeType: 'image/png', base64: image(index + missingPreviews).toString('base64'),
        });
        assert('canvas' in result, 'Synthetic mark asset upload must finish in one request');
        snapshot = result.canvas;
    }
    assert.equal(snapshot?.assets.length, 2);
    return snapshot.assets;
}

export async function seedCanvasPerfAssets(canvas, projectPath) {
    const bundleId = randomUUID();
    const assets = [];
    for (let index = 0; index < count; index++) {
        const bytes = image(index);
        const versionId = sha256(bytes);
        const asset = {
            id: 'asset-' + versionId,
            name: `${index < missingPreviews ? 'Legacy original' : 'Ready preview'} ${String(index + 1).padStart(2, '0')}.png`,
            mimeType: 'image/png',
            size: bytes.length,
            versionId,
            x: index % 6 * 308,
            y: Math.floor(index / 6) * 252,
        };
        for (let offset = 0; offset < bytes.length; offset += GOAL_CANVAS_LIMITS.uploadChunkBytes) {
            const end = Math.min(offset + GOAL_CANVAS_LIMITS.uploadChunkBytes, bytes.length);
            const ack = await canvas.stageBundleAsset({ projectPath, bundleId, versionId, mimeType: asset.mimeType, totalSize: bytes.length,
                offset, base64: bytes.subarray(offset, end).toString('base64') });
            assert.equal(ack.nextOffset, end === bytes.length ? null : end);
        }
        assets.push(asset);
    }
    const restored = await canvas.commitBundle({ projectPath, bundleId, revision: 0, bundle: { categories: [], assets } });
    assert.equal(restored.canvas.assets.length, count);
    for (const asset of assets.slice(missingPreviews)) {
        const { canvas: snapshot } = await canvas.putPreview({ projectPath, assetId: asset.id, versionId: asset.versionId, base64: preview });
        assert(snapshot.assets.find(item => item.id === asset.id)?.preview);
    }
    return assets.map((asset, index) => ({ id: asset.id, name: asset.name, size: asset.size, versionId: asset.versionId,
        hasPreview: index >= missingPreviews }));
}
