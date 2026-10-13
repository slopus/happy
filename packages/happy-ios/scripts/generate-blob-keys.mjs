// Node 24, offline. HMAC-SHA512 derivation from happy-app/encryption/deriveKey.ts.
// Secretbox bundle vectors reuse crypto-vectors.json's tweetnacl vectors.
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const fixtures = [];
for (let n = 0; n < 3; n++) {
    const dataKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i + n * 32) % 256));
    const root = createHmac('sha512', 'Happy Blobs Master Seed').update(dataKey).digest();
    const child = createHmac('sha512', root.subarray(32)).update(Buffer.concat([Buffer.from([0]), Buffer.from('session')])).digest();
    fixtures.push({ dataKey: dataKey.toString('base64'), blobKey: child.subarray(0, 32).toString('base64') });
}
writeFileSync(new URL('../Tests/HappyCryptoTests/Fixtures/blob-keys.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
