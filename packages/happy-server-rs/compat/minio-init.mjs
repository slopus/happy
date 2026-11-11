// Creates the per-server buckets with anonymous read (what `pnpm s3:init` sets up).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../happy-server/package.json', import.meta.url)));
const { Client } = require('minio');
export const minio = () => new Client({ endPoint: '127.0.0.1', port: Number(process.env.MINIO_PORT || 9187), useSSL: false, accessKey: 'compatadmin', secretKey: 'compatsecret', region: 'us-east-1' });

if (import.meta.url === `file://${process.argv[1]}`) {
    const c = minio();
    for (const b of ['happy-ts', 'happy-rs']) {
        await c.makeBucket(b, 'us-east-1');
        await c.setBucketPolicy(b, JSON.stringify({
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${b}/*`] }],
        }));
    }
}
